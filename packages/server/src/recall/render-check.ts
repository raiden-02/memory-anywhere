// The render-time sensitivity recheck (memory-policy.md §7.2 rule 8): every memory is checked
// against the current lexicons when it is rendered. One that now hits a category it was not
// flagged with is withheld, and a `render_sensitive` review item asks the owner about it once.
// Updating a lexicon therefore applies to rows stored before the update.

import type { StoreContext } from "../store/context.ts";
import { prepared } from "../store/db.ts";
import type { SensitiveCategory } from "../policy/generated.ts";
import { createReview } from "../write/rows.ts";
import { sensitiveCategories } from "../write/screens.ts";
import type { Reader } from "./reader.ts";

/** True when the content hits a blocked category other than the one the memory was stored with. */
export const newlySensitive = (content: string, flagged: SensitiveCategory | null, blocked: readonly SensitiveCategory[]): boolean =>
  sensitiveCategories(content, blocked).some((c) => c !== flagged);

/** One open `render_sensitive` review per memory. Runs inside the caller's transaction. */
export function flagRenderSensitive(ctx: StoreContext, reader: Reader, memoryIds: readonly string[]): void {
  const open = prepared(ctx.db, "SELECT 1 FROM review_item WHERE kind = 'render_sensitive' AND memory_id = ? AND resolved_at IS NULL");
  for (const memoryId of new Set(memoryIds)) {
    if (open.get(memoryId)) continue;
    createReview(
      ctx,
      { clientId: reader.clientId, clientClass: reader.clientClass, channel: "mcp", tier: 2, sessionKey: "render", repoKey: reader.repoKey, tool: undefined,
        floored: false, canElicit: false, elicitationAnswer: undefined },
      { kind: "render_sensitive", memoryId, observationId: undefined, payload: undefined },
    );
  }
}
