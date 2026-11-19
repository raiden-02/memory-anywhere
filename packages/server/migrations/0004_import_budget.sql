-- 0004: each import batch's own budget (write-path.md §10.5 steps 2 and 5).

-- What the batch may spend on the extractor: its cost so far plus the whole dollars the owner
-- confirmed when approving it (the estimate rounded up), raised by the same amount on each approved
-- resume. The batch stops `aborted_budget` once its spend reaches it; import_usd_cap still bounds
-- all imports together. A batch from before 0004 gets the budget its approved estimate gives.
ALTER TABLE import_batch ADD COLUMN budget_usd REAL NOT NULL DEFAULT 0;
UPDATE import_batch SET budget_usd = cost_usd + CAST(round(estimate_usd, 2) AS INTEGER) + (round(estimate_usd, 2) > CAST(round(estimate_usd, 2) AS INTEGER));
