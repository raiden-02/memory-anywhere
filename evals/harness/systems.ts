// Ranking systems beyond BM25. Vector baselines (one per embedding model) are registered here once
// spikes/embed-bench provides them (M0 Q14); until then the list is empty.

import { execFileSync } from "node:child_process";
import type { RankingSystem } from "./suite-r.ts";

export async function systemsFromRegistry(requested: string | undefined): Promise<RankingSystem[]> {
  void requested;
  return [];
}

export function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
