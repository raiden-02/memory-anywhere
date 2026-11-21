-- 0003: what imports add to the schema (importers.md; write-path.md §10.4–10.5).

-- The batch keeps what the owner approved: how many items the PC said it would upload (the batch
-- is done once that many are recorded and none waits for the extractor) and the estimate typed to
-- confirm it (the report compares it with cost_usd).
ALTER TABLE import_batch ADD COLUMN item_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_batch ADD COLUMN estimate_usd REAL NOT NULL DEFAULT 0;

-- An extract item waits for its job here: the redacted messages, group, date and section hint as
-- JSON. Set to NULL once the extractor has read it, so no imported text outlives its extraction.
ALTER TABLE import_item ADD COLUMN input_json TEXT;
CREATE INDEX import_item_batch ON import_item(batch_id, outcome);
