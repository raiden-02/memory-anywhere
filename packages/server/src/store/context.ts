// What every store operation needs: the database, a clock and an id source. Production uses the
// system clock and random ids; tests and the replay-determinism properties fix both.

import type { DatabaseSync } from "node:sqlite";
import type { IdSource } from "@memory-anywhere/contracts/ids";
import type { Clock } from "./clock.ts";

export interface StoreContext {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: IdSource;
}
