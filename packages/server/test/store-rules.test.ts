// write-path.md §14: one test per store rule (0–7 with 4a), each with a case where the rule applies
// and one where it does not. Rules run directly here, on a real store, with resolution from the
// real registry and the fake embedder.

import { contentNormHash } from "@memory-anywhere/contracts/normalize";
import { afterEach, describe, expect, it } from "vitest";
import { transaction } from "../src/store/db.ts";
import { loadRegistry, resolve } from "../src/write/resolve.ts";
import { applyStoreRules, type StoreResult } from "../src/write/store-rules.ts";
import type { Caller, TierNum } from "../src/write/types.ts";
import { chatCaller, fakeVector, localCaller, testStore, type TestStore } from "./helpers/store.ts";

const open: TestStore[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));
const store = async () => {
  const s = await testStore();
  open.push(s);
  return s;
};

interface Opts {
  readonly tier?: TierNum;
  readonly caller?: Caller;
  readonly entity?: string;
  readonly attribute?: string;
  readonly validFrom?: string;
  readonly supersedes?: string;
  readonly change?: "update" | "correction";
}

function put(s: TestStore, content: string, o: Opts = {}): StoreResult {
  const caller = { ...(o.caller ?? chatCaller()), tier: o.tier ?? 2 };
  const resolution = resolve(s.db, loadRegistry(s.db), { content, entity: o.entity ?? "self", attribute: o.attribute });
  return transaction(s.db, () =>
    applyStoreRules(s, caller, {
      resolution, content, contentHash: contentNormHash(content), kind: "fact", scope: "global", tier: caller.tier, reason: "user_stated",
      supersedes: o.supersedes, change: o.change ?? "update", validFrom: o.validFrom, observedAt: s.clock.now(), expiresAt: undefined,
      sensitivityCategory: undefined, vector: fakeVector(content), modelId: "fake-bow@1", dupThreshold: 0.92, writeRequestKey: undefined,
      source: { excerpt: undefined, userWords: undefined, observedAt: s.clock.now() },
    }),
  );
}

const status = (s: TestStore, id: string) => (s.db.prepare("SELECT status FROM memory WHERE id = ?").get(id) as { status: string }).status;
const versions = (s: TestStore, id: string) =>
  s.db.prepare("SELECT content, change_kind, valid_to, expired_at FROM memory_version WHERE memory_id = ? ORDER BY recorded_at, id").all(id) as {
    content: string; change_kind: string; valid_to: string | null; expired_at: string | null;
  }[];
const activeInSlot = (s: TestStore, attr: string) =>
  (s.db.prepare("SELECT count(*) n FROM memory WHERE attribute_id = ? AND status IN ('active','contested')").get(attr) as { n: number }).n;

describe("rule 0: explicit supersede", () => {
  it("with rights, updates the target in place (update) or marks the old version wrong (correction)", async () => {
    const s = await store();
    const a = put(s, "Uses vim as the main editor");
    const u = put(s, "Uses VS Code as the main editor", { supersedes: a.memoryId });
    expect(u).toMatchObject({ memoryId: a.memoryId, reason: "update", status: "active" });
    expect(versions(s, a.memoryId).map((v) => v.change_kind)).toEqual(["initial", "update"]);
    const c = put(s, "Uses Zed as the main editor", { supersedes: a.memoryId, change: "correction" });
    expect(c.reason).toBe("correction");
    expect(versions(s, a.memoryId)[1]?.expired_at).not.toBeNull();
  });

  it("without rights, keeps both values contested; an unknown id is NOT_FOUND", async () => {
    const s = await store();
    const owner = put(s, "Uses vim as the main editor", { tier: 0 });
    const t2 = put(s, "Uses VS Code as the main editor", { supersedes: owner.memoryId });
    expect(t2).toMatchObject({ reason: "contested", status: "contested", contestedWith: [owner.memoryId] });
    expect(status(s, owner.memoryId)).toBe("contested");
    expect(() => put(s, "x y z", { supersedes: "mem_01JC9Z3N4V8Q2W5X7Y9Z0A1B2C" })).toThrow(/visible/);
  });
});

describe("rule 1: the same text is already stored", () => {
  it("adds a source to the existing memory", async () => {
    const s = await store();
    const a = put(s, "Prefers short answers");
    const b = put(s, "prefers   short answers.");
    expect(b).toMatchObject({ memoryId: a.memoryId, reason: "already_stored" });
    expect((s.db.prepare("SELECT count(*) n FROM memory_source WHERE memory_id = ?").get(a.memoryId) as { n: number }).n).toBe(2);
  });
  it("does not apply to different text", async () => {
    const s = await store();
    const a = put(s, "Prefers short answers");
    expect(put(s, "Prefers long answers with examples").memoryId).not.toBe(a.memoryId);
  });
});

describe("rules 2–5: a filled `one` slot", () => {
  it("rule 2: an earlier dated value becomes closed history; a later one does not", async () => {
    const s = await store();
    const cur = put(s, "Lives in Lisbon", { validFrom: "2025-03" });
    const old = put(s, "Lives in Porto", { validFrom: "2023" });
    expect(old).toMatchObject({ reason: "historical", status: "superseded" });
    expect(versions(s, old.memoryId)[0]?.valid_to).toBe("2025-03");
    expect(put(s, "Lives in Madrid", { validFrom: "2026-01" }).reason).toBe("update");
    expect(status(s, cur.memoryId)).toBe("active");
  });

  it("rule 3: an undated import below a model-written value is undated history; a dated one is not", async () => {
    const s = await store();
    put(s, "Lives in Lisbon");
    expect(put(s, "Lives in Porto", { tier: 3 })).toMatchObject({ reason: "historical", status: "superseded" });
    expect(put(s, "Lives in Faro", { tier: 3, validFrom: "2030" }).reason).not.toBe("historical");
  });

  it("rule 4a: a profile key written at T2 by another client is contested; the same client updates", async () => {
    const s = await store();
    const chat = put(s, "Lives in Lisbon", { caller: chatCaller() });
    const other = put(s, "Lives in Berlin", { caller: localCaller() });
    expect(other).toMatchObject({ reason: "contested", contestedWith: [chat.memoryId] });
    const s2 = await store();
    put(s2, "Lives in Lisbon", { caller: chatCaller() });
    expect(put(s2, "Lives in Berlin", { caller: chatCaller() }).reason).toBe("update");
  });

  it("rule 4: with rights over the current value, updates it", async () => {
    const s = await store();
    const a = put(s, "Works at Acme", { tier: 2 });
    const b = put(s, "Works at Globex", { tier: 0 });
    expect(b).toMatchObject({ memoryId: a.memoryId, reason: "update" });
    expect(activeInSlot(s, "att_employer")).toBe(1);
  });

  it("rule 5: without rights, both values are kept as a contested pair", async () => {
    const s = await store();
    const owner = put(s, "Works at Acme", { tier: 0 });
    const model = put(s, "Works at Globex", { tier: 2 });
    expect(model).toMatchObject({ reason: "contested", contestedWith: [owner.memoryId] });
    expect(activeInSlot(s, "att_employer")).toBe(2);
    // A third value never makes a third member: the less trusted member is updated.
    put(s, "Works at Initech", { tier: 2 });
    expect(activeInSlot(s, "att_employer")).toBe(2);
  });
});

describe("rule 6: a near duplicate on the same entity and attribute", () => {
  it("adds a source, or extends the text when the new one contains the old", async () => {
    const s = await store();
    // Six content words, then the same six plus one: cosine √(6/7) ≈ 0.93 with the fake embedder.
    const a = put(s, "Enjoys long hikes in high mountain valleys");
    const b = put(s, "Enjoys long hikes in high mountain valleys yearly");
    expect(b).toMatchObject({ memoryId: a.memoryId, reason: "already_stored" });
    expect(versions(s, a.memoryId).map((v) => v.change_kind)).toEqual(["initial", "extension"]);
  });
  it("does not apply below the threshold", async () => {
    const s = await store();
    const a = put(s, "Enjoys long hikes in the mountains");
    expect(put(s, "Keeps a sourdough starter alive").memoryId).not.toBe(a.memoryId);
  });
});

describe("rule 7: insert", () => {
  it("a `many` slot takes a second value as a new memory", async () => {
    const s = await store();
    const a = put(s, "Likes jazz", { attribute: "likes" });
    const b = put(s, "Likes chess problems", { attribute: "likes" });
    expect(b.memoryId).not.toBe(a.memoryId);
    expect(b).toMatchObject({ status: "active", reason: "user_stated" });
  });
  it("is not reached when an earlier rule matched", async () => {
    const s = await store();
    const a = put(s, "Likes jazz", { attribute: "likes" });
    expect(put(s, "Likes jazz", { attribute: "likes" }).memoryId).toBe(a.memoryId);
  });
});

describe("project.status", () => {
  it("accepts only the five statuses; anything else is stored unslotted on the project", async () => {
    const s = await store();
    const ok = put(s, "Status is shipped", { entity: "memory-anywhere", attribute: "project.status" });
    const odd = put(s, "Status is going great", { entity: "memory-anywhere", attribute: "project.status" });
    const attr = (id: string) => (s.db.prepare("SELECT attribute_id FROM memory WHERE id = ?").get(id) as { attribute_id: string | null }).attribute_id;
    expect(attr(ok.memoryId)).toBe("att_project_status");
    expect(attr(odd.memoryId)).toBeNull();
  });
});
