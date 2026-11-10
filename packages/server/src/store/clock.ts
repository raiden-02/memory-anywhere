// Time for the store. Every timestamp the server writes comes from a Clock, so tests and the
// replay-determinism property can fix it. Timestamps are ISO 8601 UTC with milliseconds
// (data-model.md §1).

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A clock that starts at `startMs` and advances `stepMs` on every reading. */
export function steppingClock(startMs: number, stepMs = 1): Clock {
  let t = startMs - stepMs;
  return { now: () => (t += stepMs) };
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
