// Suite P's ablation arms (evals.md §3.3): each arm's server stage, checked on a real eval store
// without the client model: the same proposals, four sets of server decisions.

import { describe, expect, test } from "vitest";
import { save } from "../../packages/server/src/write/pipeline.ts";
import { localCaller, saveReq } from "../../packages/server/test/helpers/store.ts";
import { ARMS, armServer, isArm, type CallRecord } from "../harness/ablation.ts";
import { startEvalStore } from "../harness/headless.ts";
import { scoreTurns } from "../harness/suite-p-model.ts";

const OLLAMA = { endpoint: "http://127.0.0.1:1", model: "gpt-oss:20b" };

describe("arms", () => {
	test("a bypasses the rules; b and c add the local server model, c with the judge; d has no model", () => {
		const [a, b, c, d] = (["a", "b", "c", "d"] as const).map((arm) => armServer(arm, OLLAMA));
		expect(a).toMatchObject({ evalBuild: { bypassRules: true }, config: { llm: { provider: "none" } } });
		expect(a?.llmProvider).toBeUndefined();
		expect(b).toMatchObject({
			config: { llm: { provider: "ollama", model: "gpt-oss:20b", endpoint: OLLAMA.endpoint, judge: false } },
			llmProvider: { modelId: "ollama/gpt-oss:20b" },
		});
		expect(c).toMatchObject({ config: { llm: { provider: "ollama", judge: true } } });
		expect(d).toEqual({ config: expect.objectContaining({ llm: expect.objectContaining({ provider: "none" }) }) });
		expect(Object.keys(ARMS).filter(isArm)).toEqual(["a", "b", "c", "d"]);
		expect(isArm("e")).toBe(false);
	});

	test("on an eval store, a taste mention is stored by arm a and staged by arm d", async () => {
		const outcome = async (arm: "a" | "d") => {
			const store = await startEvalStore([], armServer(arm, OLLAMA));
			try {
				const r = await save(store.app.write, localCaller(), saveReq("Likes jazz"), {
					idempotencyKey: `ablation-${arm}`,
					observedAt: Date.now(),
				});
				return r.kind === "result" ? r.outcome.outcome : r.kind;
			} finally {
				await store.close();
			}
		};
		expect(await outcome("a")).toBe("active");
		expect(await outcome("d")).toBe("observation");
	});

	test("an unreachable server model falls back: arm b decides as arm d does", async () => {
		const calls: CallRecord[] = [];
		const store = await startEvalStore([], armServer("b", OLLAMA, calls));
		try {
			const r = await save(store.app.write, localCaller(), saveReq("Likes jazz"), {
				idempotencyKey: "ablation-b",
				observedAt: Date.now(),
			});
			expect(r).toMatchObject({ kind: "result", outcome: { outcome: "observation", reason: "single_mention" } });
			expect(calls.map((c) => c.outcome)).not.toContain("ok");
			expect(calls.length).toBeGreaterThan(0);
		} finally {
			await store.close();
		}
	});
});

test("scoreTurns counts each label's turns that ended as labelled", () => {
	const t = (
		label: "save" | "observe" | "skip",
		outcome: "stored" | "observed" | "missed" | "kept_out" | "false_save",
		turn: number,
	) => ({ conversation: "PM-001", turn, label, outcome });
	const { rates, outcomes } = scoreTurns([
		t("save", "stored", 1),
		t("save", "missed", 2),
		t("skip", "kept_out", 3),
		t("skip", "false_save", 4),
	]);
	expect(rates.save).toMatchObject({ k: 1, n: 2 });
	expect(rates.skip).toMatchObject({ k: 1, n: 2 });
	expect(rates.observe).toMatchObject({ k: 0, n: 0 });
	expect(outcomes["save"]).toMatchObject({ stored: 1, missed: 1 });
});
