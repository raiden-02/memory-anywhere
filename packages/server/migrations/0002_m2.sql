-- 0002 (M2): what the remote store adds to schema 1. Applied before the first aws deployment.

-- Alerts (operations.md §2) are kept once per kind and subject while open: a repeat of the same
-- alert raises `count` and `last_at` instead of adding a row, so a busy client cannot flood the
-- list, the email or the digest. `notified_at` is when an immediate alert last went to the
-- outbox; `digested_at` is when it was last included in a daily digest.
ALTER TABLE alert ADD COLUMN subject     TEXT NOT NULL DEFAULT '';   -- a client id, a job kind, … ('' when the kind has one subject)
ALTER TABLE alert ADD COLUMN count       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE alert ADD COLUMN last_at     TEXT;
ALTER TABLE alert ADD COLUMN notified_at TEXT;
ALTER TABLE alert ADD COLUMN digested_at TEXT;
CREATE INDEX alert_open ON alert(kind, subject) WHERE acknowledged_at IS NULL;
