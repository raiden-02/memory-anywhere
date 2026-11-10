// Property tests (write-path.md §14), 1,000 runs each, on in-memory stores:
// - replaying any sequence of write requests gives the same content hash, and re-sending it changes nothing;
// - any interleaving of saves for one `one` slot leaves exactly one active memory or one contested pair;
// - forget then undo restores the identical content hash;
// - purge leaves no plaintext.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { contentHash } from "../src/store/dump.ts";
import { forgetByOwner, purgeMemory, undoForget } from "../src/write/forget.ts";
import { save, type WriteEnv } from "../src/write/pipeline.ts";
import type { Caller, SaveRequest } from "../src/write/types.ts";
import { chatCaller, ownerCaller, saveReq, testStore, writeEnv, type TestStore } from "./helpers/store.ts";

const RUNS = Number(process.env["MA_PROPERTY_RUNS"] ?? 1000);
/** 1,000 runs on fresh in-memory stores take a few seconds to a minute each. */
const PROPERTY_TIMEOUT_MS = 300_000;

const FACTS = [
  ["Lives in Lisbon", "i live in lisbon these days"],
  ["Lives in Porto", "i live in porto now actually"],
  ["Works at Acme", "i work at acme as an engineer"],
  ["Works at Globex", "i work at globex these days"],
  ["Prefers short answers", "keep answers short from now on"],
  ["Likes jazz", "i like listening to jazz"],
  ["Reads science fiction", "i read science fiction books"],
  ["Uses pnpm for every project", "i use pnpm for every project"],
] as const;

interface Step {
  readonly fact: number;
  readonly stated: boolean;
  readonly who: "chat" | "owner";
  readonly session: number;
  readonly kind: "fact" | "preference";
}

const step: fc.Arbitrary<Step> = fc.record({
  fact: fc.nat({ max: FACTS.length - 1 }),
  stated: fc.boolean(),
  who: fc.constantFrom("chat", "owner"),
  session: fc.nat({ max: 3 }),
  kind: fc.constantFrom("fact", "preference"),
});

function request(s: Step): { caller: Caller; req: SaveRequest } {
  const [content, words] = FACTS[s.fact] ?? FACTS[0];
  const caller = s.who === "owner" ? ownerCaller() : chatCaller({ sessionKey: `cli_chat:${s.session}` });
  return { caller, req: saveReq(content, { kind: s.kind, ...(s.stated ? { user_words: words } : {}) }) };
}

async function apply(env: WriteEnv, steps: readonly Step[], keyBase: string): Promise<void> {
  for (const [i, st] of steps.entries()) {
    const { caller, req } = request(st);
    // Sessions are hours apart so promotion can happen; keys are fixed per position.
    const r = await save(env, caller, req, { idempotencyKey: `pxs_${keyBase}${String(i).padStart(10, "0")}`, observedAt: env.ctx.clock.now() + st.session * 7 * 3_600_000 });
    expect(r.kind).toBe("result");
  }
}

async function fresh(): Promise<{ s: TestStore; env: WriteEnv }> {
  const s = await testStore({ memory: true, seed: 99 });
  return { s, env: writeEnv(s) };
}

const KEY_BASE = "01JC9Z3N4V8Q2W";

describe("write path properties", () => {
  it("replays are deterministic and idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 8 }), async (steps) => {
        const a = await fresh();
        const b = await fresh();
        try {
          await apply(a.env, steps, KEY_BASE);
          await apply(b.env, steps, KEY_BASE);
          const h = contentHash(a.s.db);
          expect(contentHash(b.s.db)).toBe(h);
          await apply(a.env, steps, KEY_BASE); // the same requests again: stored results, no change
          expect(contentHash(a.s.db)).toBe(h);
        } finally {
          a.s.close();
          b.s.close();
        }
      }),
      { numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("a `one` slot ends with exactly one active memory or one contested pair", async () => {
    const cityStep = fc.record({ city: fc.constantFrom("Lisbon", "Porto", "Berlin", "Oslo"), who: fc.constantFrom<"chat" | "owner">("chat", "owner"), session: fc.nat({ max: 3 }) });
    await fc.assert(
      fc.asyncProperty(fc.array(cityStep, { minLength: 1, maxLength: 8 }), async (steps) => {
        const { s, env } = await fresh();
        try {
          for (const [i, st] of steps.entries()) {
            const caller = st.who === "owner" ? ownerCaller() : chatCaller({ sessionKey: `cli_chat:${st.session}` });
            await save(env, caller, saveReq(`Lives in ${st.city}`, { user_words: `i live in ${st.city.toLowerCase()} these days` }), {
              idempotencyKey: `pxs_${KEY_BASE}${String(i).padStart(10, "0")}`, observedAt: s.clock.now(),
            });
          }
          const rows = s.db.prepare("SELECT status FROM memory WHERE attribute_id = 'att_city' AND status IN ('active','contested')").all() as { status: string }[];
          const active = rows.filter((r) => r.status === "active").length;
          const contested = rows.filter((r) => r.status === "contested").length;
          expect((active === 1 && contested === 0) || (active === 0 && contested === 2)).toBe(true);
        } finally {
          s.close();
        }
      }),
      { numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("forget then undo restores the identical content hash", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), fc.nat(), async (steps, pick) => {
        const { s, env } = await fresh();
        try {
          await apply(env, steps, KEY_BASE);
          const active = s.db.prepare("SELECT id FROM memory WHERE status IN ('active','contested') ORDER BY id").all() as { id: string }[];
          if (active.length === 0) return;
          const id = (active[pick % active.length] as { id: string }).id;
          const before = contentHash(s.db);
          forgetByOwner(s, id, 30);
          expect(contentHash(s.db)).not.toBe(before);
          expect(undoForget(s, id)).toBe(true);
          expect(contentHash(s.db)).toBe(before);
        } finally {
          s.close();
        }
      }),
      { numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);

  it("purge leaves no plaintext of the memory in the store", async () => {
    const word = fc.stringMatching(/^[a-z]{6,10}$/);
    await fc.assert(
      fc.asyncProperty(word, word, async (w1, w2) => {
        const { s, env } = await fresh();
        try {
          const canary = `Owns a ${w1} named ${w2}`;
          const r = await save(env, chatCaller(), saveReq(canary, { user_words: `i own a ${w1} named ${w2}` }), { idempotencyKey: `pxs_${KEY_BASE}0000000001`, observedAt: s.clock.now() });
          const id = r.kind === "result" ? r.outcome.id : undefined;
          if (!id?.startsWith("mem_")) return;
          forgetByOwner(s, id, 30);
          purgeMemory(s, id, "owner");
          const text = JSON.stringify([
            s.db.prepare("SELECT content FROM memory_version").all(),
            s.db.prepare("SELECT excerpt, user_words FROM memory_source").all(),
            s.db.prepare("SELECT content FROM observation").all(),
            s.db.prepare("SELECT content, excerpt, user_words FROM observation_mention").all(),
            s.db.prepare("SELECT * FROM memory_fts").all(),
            s.db.prepare("SELECT payload_json FROM review_item").all(),
            s.db.prepare("SELECT result_json FROM write_request").all(),
          ]).toLowerCase();
          expect(text).not.toContain(w2);
        } finally {
          s.close();
        }
      }),
      { numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);
});
