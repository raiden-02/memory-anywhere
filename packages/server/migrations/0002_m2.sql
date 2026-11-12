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

-- Pairing windows (auth-and-security.md §4.1, §4.4, §5.6): what a window allows and how it was used.
ALTER TABLE pairing_window ADD COLUMN registration_used  INTEGER NOT NULL DEFAULT 0;  -- one registration per window
ALTER TABLE pairing_window ADD COLUMN code_attempts      INTEGER NOT NULL DEFAULT 0;  -- wrong pair codes typed (5 close the window)
ALTER TABLE pairing_window ADD COLUMN desktop            INTEGER NOT NULL DEFAULT 0;  -- Other: a desktop app with a loopback redirect
ALTER TABLE pairing_window ADD COLUMN other_write        INTEGER NOT NULL DEFAULT 1;  -- Other: read-write (1) or read-only (0)
ALTER TABLE pairing_window ADD COLUMN machine_name       TEXT;                         -- PC: the machine this grant is for
ALTER TABLE pairing_window ADD COLUMN replaces_client_id TEXT;                         -- Replace: the client whose grant this one ends

-- A passkey blocked by the clone check (§3.2) until the owner re-confirms with another passkey.
ALTER TABLE passkey ADD COLUMN blocked_at TEXT;

-- WebAuthn challenges (§3.2): 32 random bytes, single use, 2 minutes, bound to what asked for them
-- (`setup`, `login`, `stepup:<session>`, `consent:<interaction>`, `approve:<request>`).
CREATE TABLE webauthn_challenge (
  value       TEXT PRIMARY KEY,                       -- base64url
  purpose     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
