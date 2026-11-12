// The CLI's owner commands (config-and-cli.md §4.2) and their step-up (auth-and-security.md §6,
// mcp-interface.md §7). In aws mode the PC grant cannot change policy by itself: each command asks
// the owner to approve it with a passkey, for exactly these arguments.
//
//   mema enable ── POST /v1/admin/stepup {command, args} ──► {request_id, user_code, approve_url}
//        │         prints the link and code; the owner approves on admin.{host}/approve/<id>
//        ├── GET /v1/admin/stepup/<id> every 2 s ──► pending … approved + token (once)
//        └── POST /v1/admin/<command> args, header MA-Step-Up: <token> ──► the result
//
// The token lives only in this process's memory (topology-and-ipc.md §10). In local mode the
// local token is the owner credential, so the command is sent at once.

import type { ClientConfigT } from "./config.ts";
import { StoreError, type StoreClient } from "./store-client.ts";

export type AdminCommand = "repo-enable" | "repo-disable" | "project-track" | "project-add" | "export" | "review";

const POLL_MS = 2000;
const CALL_TIMEOUT_MS = 10_000;

/** The owner did not approve: denied, or the five minutes ran out. Exit code 5 (config-and-cli.md §4). */
export class StepUpError extends Error {
  override readonly name = "StepUpError";
  readonly status: "denied" | "expired";
  constructor(status: "denied" | "expired") {
    super(status === "denied" ? "the owner denied this command" : "the approval expired before the owner approved it; run the command again");
    this.status = status;
  }
}

export interface StepUpDeps {
  readonly config: ClientConfigT;
  readonly store: StoreClient;
  readonly out: (line: string) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly openBrowser: (url: string) => Promise<boolean>;
}

interface StepUpStart {
  readonly request_id: string;
  readonly user_code: string;
  readonly approve_url: string;
  readonly expires_in: number;
}

interface StepUpStatus {
  readonly status: "pending" | "approved" | "denied" | "expired";
  readonly token?: string;
}

/** Asks the owner to approve `command` with `args`; returns the step-up token. */
export async function approval(d: StepUpDeps, command: AdminCommand, args: Record<string, unknown>): Promise<string> {
  const s = await d.store.request<StepUpStart>("POST", "/v1/admin/stepup", { command, args }, CALL_TIMEOUT_MS);
  if (!s) throw new StoreError("rejected", "the store did not start the approval");
  d.out(`Approve this in the browser with a passkey (code ${s.user_code}):`);
  d.out(s.approve_url);
  await d.openBrowser(s.approve_url);
  const until = d.now() + s.expires_in * 1000;
  for (;;) {
    await d.sleep(POLL_MS);
    const st = await d.store.request<StepUpStatus>("GET", `/v1/admin/stepup/${encodeURIComponent(s.request_id)}`, undefined, CALL_TIMEOUT_MS);
    if (st?.status === "approved" && st.token) return st.token;
    if (st?.status === "denied") throw new StepUpError("denied");
    if (st?.status === "expired" || d.now() > until) throw new StepUpError("expired");
  }
}

/** Runs an owner command: at once in local mode, after the owner's approval in aws mode. */
export async function adminCall<T>(d: StepUpDeps, command: AdminCommand, args: Record<string, unknown>): Promise<T | undefined> {
  if (d.config.store.mode === "local") return d.store.request<T>("POST", `/v1/admin/${command}`, args, CALL_TIMEOUT_MS);
  const token = await approval(d, command, args);
  return d.store.request<T>("POST", `/v1/admin/${command}`, args, CALL_TIMEOUT_MS, { stepUp: token });
}

/** As `adminCall`, for a command whose answer is a file (export): the response's bytes. */
export async function adminDownload(d: StepUpDeps, command: AdminCommand, args: Record<string, unknown>): Promise<{ contentType: string; bytes: Uint8Array }> {
  const stepUp = d.config.store.mode === "local" ? undefined : await approval(d, command, args);
  return d.store.download("POST", `/v1/admin/${command}`, args, 60_000, stepUp ? { stepUp } : {});
}
