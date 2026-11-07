# Negative results

Every failed attempt, wrong assumption and overturned result, with where it is recorded. Newest milestone first.

## M0

| Date | Question | What failed or was overturned | Outcome | Record |
| --- | --- | --- | --- | --- |
| 2026-11-07 | Q20 | One 50-handshake run picked us-east-2 (93.0 vs 94.3 ms); a repeat picked us-east-1. The spec's "lowest median; ties → us-east-1" did not define a tie | The tie is defined statistically (CI of the median difference includes 0); us-east-1 chosen | [ADR-0112](../decisions/ADR-0112-region-and-litestream.md) |
