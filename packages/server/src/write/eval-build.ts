// The eval build's rule bypass (evals.md §3.3, ablation arm a, "model only"): every save the
// client's model proposes is stored as it asked, with no screens, no decision table and no server
// model call, so suite P can measure what the server stage adds over the model alone.
//
// It is not a setting. No `server.toml` key and no command-line flag reaches it: only code that
// builds an App or a WriteEnv by hand can pass it, which the eval harness does and the server's
// own entry points do not. And it refuses to run anywhere but a throwaway store: an in-memory
// database in local mode, which no server serves the owner from.

import type { DatabaseSync } from "node:sqlite";
import type { ServerConfigT } from "../config/schema.ts";
import type { Decision, TierNum } from "./types.ts";

/** What the eval harness passes to turn the server's rules off (arm a). */
export interface EvalBuild {
	readonly bypassRules: true;
}

/** Throws unless the store is an eval store: in-memory, local mode. */
export function assertEvalStore(db: DatabaseSync, config: ServerConfigT): void {
	if (db.location() !== null)
		throw new Error("the eval build's rule bypass runs only on an in-memory eval store, never on a store file");
	if (config.server.mode !== "local") throw new Error("the eval build's rule bypass runs only in local mode");
}

/** The decision when the rules are bypassed: active at the caller's tier, as the model proposed. */
export function modelOnlyDecision(tier: TierNum): Decision {
	return { row: "eval_model_only", kind: "active", reason: "user_stated", tier, preferenceConfirm: false };
}
