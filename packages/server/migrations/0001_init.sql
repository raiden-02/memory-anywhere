-- Migration 0001: the initial schema. Copied verbatim from docs/spec/data-model.md §2 (DDL) and §3
-- (views); a test fails if this file and the spec differ. Seeds (§4) are inserted by 0001_init.ts.

-- ===== meta and policy =====
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Required keys: schema_version (integer as text), store_id (ULID), store_hmac_key (base64, 32 bytes),
-- audit_hmac_key (base64, 32 bytes), audit_hmac_key_rotated_at, embedding_model_id, embedding_dim,
-- embedding_query_prefix, embedding_doc_prefix, embedding_files_sha256 (JSON), dup_threshold,
-- abstain_cosine, sections_cluster_threshold, policy_version, event_chain_head,
-- mrtr_key (base64, 32 bytes; AES-256-GCM key for elicitation requestState, mcp-interface.md §5),
-- cookie_secret (base64, 32 bytes; signs admin and AS cookies; rotated on restore; never exported).

CREATE TABLE section (
  id            TEXT PRIMARY KEY,                     -- sec_<slug> for seeds, sec_<ULID> for dynamic
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 32),
  description   TEXT CHECK (description IS NULL OR length(description) <= 80),
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  origin        TEXT NOT NULL CHECK (origin IN ('default','dynamic','owner')),
  approved      INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),  -- description shown in section map only if 1
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','undone','merged')),
  merged_into   TEXT REFERENCES section(id),
  sort_order    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL                          -- 'seed' | 'owner' | 'job:<job id>'
);

CREATE TABLE attribute (
  id            TEXT PRIMARY KEY,                     -- att_<name with . replaced by _>
  name          TEXT NOT NULL UNIQUE,                 -- e.g. 'city', 'project.status'
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('self','person','project','org','place','thing','any')),
  cardinality   TEXT NOT NULL CHECK (cardinality IN ('one','many')),
  section_id    TEXT NOT NULL REFERENCES section(id),
  taste_class   INTEGER NOT NULL DEFAULT 0 CHECK (taste_class IN (0,1)),
  profile_key   INTEGER NOT NULL DEFAULT 0 CHECK (profile_key IN (0,1)),  -- eligible for profile "Key facts"
  restricted    INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0,1)),   -- CLI/export only, never MCP
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  sort_order    INTEGER NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('seed','owner')),
  description   TEXT NOT NULL
);

-- ===== entities =====
CREATE TABLE entity (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('self','person','project','org','place','thing')),
  canonical_name  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
  merged_into     TEXT REFERENCES entity(id),
  approved        INTEGER NOT NULL CHECK (approved IN (0,1)),  -- 1 if created at T0 or approved by the owner; project entities from any other channel start at 0
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX entity_self ON entity(type) WHERE type = 'self';   -- exactly one self entity: ent_self

CREATE TABLE entity_alias (
  alias_norm   TEXT NOT NULL,                       -- norm(alias)
  entity_id    TEXT NOT NULL REFERENCES entity(id),
  origin       TEXT NOT NULL CHECK (origin IN ('canonical','seed','owner','llm')),
  approved     INTEGER NOT NULL CHECK (approved IN (0,1)),  -- llm-origin aliases start at 0 and are ignored until approved
  created_at   TEXT NOT NULL,
  PRIMARY KEY (alias_norm, entity_id)
);
CREATE INDEX entity_alias_lookup ON entity_alias(alias_norm) WHERE approved = 1;

CREATE TABLE entity_activity (
  entity_id         TEXT PRIMARY KEY REFERENCES entity(id),
  last_activity_at  TEXT NOT NULL,
  last_client_id    TEXT NOT NULL,
  session_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE repo (
  repo_key            TEXT PRIMARY KEY,             -- rk_<32 hex>, topology-and-ipc.md §8
  display_name        TEXT NOT NULL,
  enabled             INTEGER NOT NULL CHECK (enabled IN (0,1)),
  capture             INTEGER NOT NULL CHECK (capture IN (0,1)),
  project_entity_id   TEXT REFERENCES entity(id),
  enabled_at          TEXT,
  disabled_at         TEXT,
  untracked_prompted  INTEGER NOT NULL DEFAULT 0 CHECK (untracked_prompted IN (0,1))
);

-- ===== memories =====
CREATE TABLE memory (
  id                    TEXT PRIMARY KEY,
  entity_id             TEXT NOT NULL REFERENCES entity(id),
  attribute_id          TEXT REFERENCES attribute(id),
  section_id            TEXT NOT NULL REFERENCES section(id),
  kind                  TEXT NOT NULL CHECK (kind IN ('fact','preference','instruction','event')),
  scope                 TEXT NOT NULL DEFAULT 'global',   -- 'global' | 'repo:rk_…'
  status                TEXT NOT NULL CHECK (status IN ('active','contested','pending_review','superseded','forgotten','purged')),
  pinned                INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  sensitivity_category  TEXT,                              -- NULL or a category id from policy/sensitive/
  expires_at            TEXT,                              -- events only
  superseded_by         TEXT REFERENCES memory(id),
  forgotten_at          TEXT,
  purge_after           TEXT,                              -- forgotten_at + 30 days
  purged_at             TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  created_by_client_id  TEXT NOT NULL,
  recall_count          INTEGER NOT NULL DEFAULT 0,
  last_recalled_at      TEXT
);
CREATE INDEX memory_slot ON memory(entity_id, attribute_id) WHERE attribute_id IS NOT NULL AND status IN ('active','contested');
CREATE INDEX memory_status ON memory(status);
CREATE INDEX memory_section ON memory(section_id, status);

CREATE TABLE memory_version (
  id                    TEXT PRIMARY KEY,
  memory_id             TEXT NOT NULL REFERENCES memory(id),
  content               TEXT,                              -- NULL after purge; ≤ 400 chars; CR/LF/control chars stripped
  content_norm_hash     TEXT NOT NULL,                     -- kept after purge (hash of normalized text)
  valid_from            TEXT,
  valid_from_precision  TEXT CHECK (valid_from_precision IN ('year','month','day','instant')),
  valid_to              TEXT,
  valid_to_precision    TEXT CHECK (valid_to_precision IN ('year','month','day','instant')),
  recorded_at           TEXT NOT NULL,
  expired_at            TEXT,
  trust_tier            INTEGER NOT NULL CHECK (trust_tier BETWEEN 0 AND 3),
  tier_basis            TEXT NOT NULL CHECK (tier_basis IN ('owner','elicitation','model','capture','import','promotion')),
  extraction_method     TEXT NOT NULL CHECK (extraction_method IN ('live','capture','import','admin','promotion')),
  change_kind           TEXT NOT NULL CHECK (change_kind IN ('initial','update','correction','historical','undated_historical','extension','resolution','confirmation')),
  client_id             TEXT NOT NULL,                     -- client_policy.client_id of the write that created this version ('owner' for T0)
  write_request_key     TEXT
);
CREATE INDEX version_current ON memory_version(memory_id) WHERE valid_to IS NULL AND expired_at IS NULL;
CREATE INDEX version_hash ON memory_version(content_norm_hash);

CREATE TABLE source (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,                  -- client_policy.client_id
  client_class    TEXT NOT NULL CHECK (client_class IN ('chat','coding','admin','import','capture')),
  tool            TEXT,                           -- MA-Tool header value (untrusted label) or vendor name
  repo_key        TEXT,
  session_key     TEXT NOT NULL,                  -- write-path.md §2
  import_item_key TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE memory_source (
  id           TEXT PRIMARY KEY,
  memory_id    TEXT NOT NULL REFERENCES memory(id),
  version_id   TEXT REFERENCES memory_version(id),
  source_id    TEXT NOT NULL REFERENCES source(id),
  excerpt      TEXT,                              -- ≤ 300 chars; NULL after purge
  user_words   TEXT,                              -- ≤ 200 chars, model-reported unless tier_basis says otherwise; NULL after purge
  observed_at  TEXT NOT NULL
);
CREATE INDEX memory_source_memory ON memory_source(memory_id);

CREATE TABLE memory_contest (
  memory_id        TEXT NOT NULL REFERENCES memory(id),
  other_memory_id  TEXT NOT NULL REFERENCES memory(id),
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  resolution       TEXT CHECK (resolution IN ('kept_this','kept_other','both_valid')),
  PRIMARY KEY (memory_id, other_memory_id)
);

-- ===== observations =====
CREATE TABLE observation (
  id                  TEXT PRIMARY KEY,
  content             TEXT,                        -- NULL after purge
  content_norm_hash   TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('fact','preference','event')),
  entity_id           TEXT REFERENCES entity(id),
  attribute_id        TEXT REFERENCES attribute(id),
  section_id          TEXT NOT NULL REFERENCES section(id),
  best_tier           INTEGER NOT NULL CHECK (best_tier BETWEEN 0 AND 3),
  mention_count       INTEGER NOT NULL DEFAULT 1,
  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  expires_at          TEXT NOT NULL,               -- last_seen + observation.ttl_days
  status              TEXT NOT NULL CHECK (status IN ('open','promoted','expired','forgotten','purged')),
  promoted_memory_id  TEXT REFERENCES memory(id),
  created_by_client_id TEXT NOT NULL
);
CREATE INDEX observation_open ON observation(status, content_norm_hash);
CREATE INDEX observation_slot ON observation(entity_id, attribute_id) WHERE status = 'open';

CREATE TABLE observation_mention (
  id              TEXT PRIMARY KEY,
  observation_id  TEXT NOT NULL REFERENCES observation(id),
  source_id       TEXT NOT NULL REFERENCES source(id),
  client_id       TEXT NOT NULL,
  floored         INTEGER NOT NULL CHECK (floored IN (0,1)),  -- 1 if the client's save_floor = observation (does not count toward promotion)
  content         TEXT,                                        -- the mention's normalized-input content; NULL after purge
  trust_tier      INTEGER NOT NULL CHECK (trust_tier BETWEEN 0 AND 3),
  session_key     TEXT NOT NULL,                               -- write-path.md §2.2
  excerpt         TEXT,                                        -- NULL after purge
  user_words      TEXT,                                        -- NULL after purge
  observed_at     TEXT NOT NULL,
  write_request_key TEXT NOT NULL
);

-- ===== vectors and search =====
CREATE TABLE embedding (
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('version','observation')),
  owner_id    TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vector      BLOB NOT NULL,                       -- float32 little-endian, L2-normalized, length = 4*dim
  PRIMARY KEY (owner_type, owner_id, model_id)
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  version_id UNINDEXED,
  content,
  excerpts,
  aliases,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
-- Holds one row per CURRENT version of a memory with status active or contested.
-- Maintained by application code inside the write transaction (no triggers).

-- ===== deletion support =====
CREATE TABLE suppression (
  id            TEXT PRIMARY KEY,
  hmac          TEXT NOT NULL,                     -- HMAC-SHA256(store_hmac_key, norm(content)), hex
  slot_hmac     TEXT,                              -- HMAC-SHA256(store_hmac_key, entity_id || '|' || attribute_id || '|' || norm(content)) for slotted memories
  memory_id     TEXT,
  key_id        TEXT NOT NULL DEFAULT 'local',      -- 'local' = meta.store_hmac_key; else foreign_suppression_key.key_id
  reason        TEXT NOT NULL CHECK (reason IN ('forget','purge')),
  created_at    TEXT NOT NULL,
  lifted_at     TEXT
);
CREATE INDEX suppression_hmac ON suppression(hmac) WHERE lifted_at IS NULL;

CREATE TABLE foreign_suppression_key (             -- HMAC keys of other stores whose suppressions were imported (§10)
  key_id          TEXT PRIMARY KEY,                  -- sha256 of the key, first 16 hex
  key             TEXT NOT NULL,                     -- base64
  source_store_id TEXT NOT NULL,
  imported_at     TEXT NOT NULL
);

-- ===== requests, review, jobs =====
CREATE TABLE write_request (
  idempotency_key  TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL,
  op               TEXT NOT NULL CHECK (op IN ('save','forget','prompt','capture','import','admin')),
  received_at      TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  reason           TEXT NOT NULL,
  result_json      TEXT NOT NULL,                  -- the exact result returned; ids and codes only, no content
  expires_at       TEXT NOT NULL                   -- received_at + 180 days
);

CREATE TABLE review_item (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('instruction','sensitive','forget_protected','contested','section_proposal','alias_proposal','import_sensitive','render_sensitive','preference_confirm','project_proposal')),
  memory_id      TEXT REFERENCES memory(id),        -- the pending_review memory, if any
  observation_id TEXT REFERENCES observation(id),
  payload_json   TEXT,                              -- redacted proposal; NULL after resolution + 30 days or purge
  client_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolution     TEXT CHECK (resolution IN ('approved','rejected','expired'))
);

CREATE TABLE job (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('extract','reslot','embed','reembed','section_cluster','purge','expire','digest','vacuum','manifest','prune','hmac_rotate')),
  payload_json TEXT NOT NULL,                       -- ids only
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','dropped')),
  last_error  TEXT,                                 -- error code and message, never content
  created_at  TEXT NOT NULL
);
CREATE INDEX job_due ON job(status, next_at);

-- ===== import and extraction =====
CREATE TABLE import_batch (
  id           TEXT PRIMARY KEY,
  source_type  TEXT NOT NULL,                       -- importers.md source ids
  file_sha256  TEXT NOT NULL,
  dry_run      INTEGER NOT NULL CHECK (dry_run IN (0,1)),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running','done','failed','aborted_budget')),
  counts_json  TEXT NOT NULL DEFAULT '{}',
  cost_usd     REAL NOT NULL DEFAULT 0
);

CREATE TABLE import_item (
  idempotency_key   TEXT PRIMARY KEY,               -- sha256(source_type|source_item_id|extractor_version|ordinal)
  batch_id          TEXT NOT NULL REFERENCES import_batch(id),
  source_type       TEXT NOT NULL,
  source_item_id    TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  ordinal           INTEGER NOT NULL,
  outcome           TEXT NOT NULL,
  reason            TEXT NOT NULL,
  memory_id         TEXT,
  observation_id    TEXT
);

CREATE TABLE extraction_cache (
  input_hash      TEXT PRIMARY KEY,                 -- sha256(input || prompt_version || model_id)
  prompt_version  TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  output_json     TEXT,                              -- NULL after purge of any memory derived from it
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL                     -- created_at + 30 days
);

CREATE TABLE session_prompt (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  repo_key     TEXT NOT NULL,
  tool_session TEXT NOT NULL,                       -- hook session id (untrusted label)
  prompt       TEXT,                                -- redacted capture text; NULL after purge or after extraction
  received_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL                        -- received_at + 24 h
);
CREATE INDEX session_prompt_lookup ON session_prompt(client_id, repo_key, received_at);

-- ===== clients, budgets, audit =====
CREATE TABLE client_policy (
  client_id              TEXT PRIMARY KEY,           -- cli_<ULID>; maps 1:1 to an OAuth client or the local token
  oauth_client_id        TEXT UNIQUE,                -- library client_id (CIMD URL, DCR id, static id); NULL for local
  display_name           TEXT NOT NULL,
  vendor                 TEXT NOT NULL CHECK (vendor IN ('claude','chatgpt','gemini','grok','claude_code_direct','pc','local','eval','other')),
  class                  TEXT NOT NULL CHECK (class IN ('chat','coding')),
  read                   INTEGER NOT NULL CHECK (read IN (0,1)),
  write                  INTEGER NOT NULL CHECK (write IN (0,1)),
  section_allow_json     TEXT NOT NULL,              -- JSON array of section ids, or ["*"]
  sensitive_allow_json   TEXT NOT NULL DEFAULT '[]',
  save_floor             TEXT NOT NULL DEFAULT 'none' CHECK (save_floor IN ('none','observation')),
  profile_eligible       INTEGER NOT NULL DEFAULT 1 CHECK (profile_eligible IN (0,1)),
  quota_saves_per_hour   INTEGER NOT NULL DEFAULT 20,    -- set from client_defaults.<class> at creation
  quota_forgets_per_day  INTEGER NOT NULL DEFAULT 5,
  read_budget_24h        INTEGER NOT NULL DEFAULT 60,    -- set from client_defaults.<class> at creation
  read_budget_1h         INTEGER NOT NULL DEFAULT 20,
  elicitation            TEXT NOT NULL DEFAULT 'none' CHECK (elicitation IN ('none','verified')),
  refresh_rotation       TEXT NOT NULL DEFAULT 'rotate' CHECK (refresh_rotation IN ('rotate','fixed')),
  last_policy_version    TEXT,
  last_policy_version_at TEXT,
  created_at             TEXT NOT NULL,
  revoked_at             TEXT
);

CREATE TABLE read_ledger (
  client_id      TEXT NOT NULL,
  memory_id      TEXT NOT NULL,
  first_read_at  TEXT NOT NULL,
  PRIMARY KEY (client_id, memory_id, first_read_at)
);
CREATE INDEX read_ledger_window ON read_ledger(client_id, first_read_at);
-- Rows older than 48 h are deleted by job 'prune'.

CREATE TABLE audit (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  client_id     TEXT,
  op            TEXT NOT NULL,                      -- tool name or /v1 route or admin action
  query_hmac    TEXT,                               -- HMAC-SHA256(audit_hmac_key, norm(query))
  result_ids    TEXT,                               -- JSON array of ids
  outcome       TEXT NOT NULL,
  status_code   INTEGER,
  ip_prefix     TEXT,                               -- IPv4 /24 or IPv6 /48
  latency_ms    INTEGER NOT NULL
);
CREATE INDEX audit_at ON audit(at);

CREATE TABLE event (
  id         TEXT PRIMARY KEY,                       -- evt_<ULID>, strictly increasing
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,                          -- client_id, 'owner', 'job:<id>', 'system'
  op         TEXT NOT NULL,                          -- e.g. memory.insert, memory.update, memory.forget, memory.purge, grant.create
  refs_json  TEXT NOT NULL,                          -- ids only, never content
  undo_json  TEXT,                                   -- ids and prior status/version pointers needed to undo; never content
  prev_hash  TEXT NOT NULL,                          -- hash of previous event, or 64 zeros
  hash       TEXT NOT NULL                           -- sha256(prev_hash || id || at || actor || op || refs_json || coalesce(undo_json,''))
);

CREATE TABLE alert (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,                    -- operations.md §2 alert ids
  at               TEXT NOT NULL,
  details_json     TEXT NOT NULL,                    -- counts and ids only
  acknowledged_at  TEXT
);

CREATE TABLE llm_spend (
  day         TEXT NOT NULL,                         -- YYYY-MM-DD UTC
  purpose     TEXT NOT NULL CHECK (purpose IN ('live','import')),
  usd         REAL NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, purpose)
);

-- ===== owner authentication (auth-and-security.md §3) =====
CREATE TABLE owner (
  id          INTEGER PRIMARY KEY CHECK (id = 1),     -- exactly one owner
  created_at  TEXT NOT NULL
);
CREATE TABLE passkey (
  id              TEXT PRIMARY KEY,
  credential_id   TEXT NOT NULL UNIQUE,               -- base64url
  public_key      BLOB NOT NULL,
  sign_count      INTEGER NOT NULL,
  transports_json TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0,1)),   -- BE flag: 1 = synced passkey
  aaguid          TEXT NOT NULL,                                       -- authenticator provider id
  label           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT,
  revoked_at      TEXT
);
CREATE TABLE recovery_code (
  id        TEXT PRIMARY KEY,
  hash      TEXT NOT NULL,                            -- argon2id
  batch_id  TEXT NOT NULL,
  used_at   TEXT
);
CREATE TABLE setup_token (
  hash        TEXT PRIMARY KEY,                       -- sha256
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE TABLE admin_session (
  id_hash        TEXT PRIMARY KEY,                    -- sha256 of cookie value
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  uv_at          TEXT NOT NULL,                       -- time of the last user-verified assertion
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT
);
CREATE TABLE stepup_request (
  id             TEXT PRIMARY KEY,
  command        TEXT NOT NULL,                       -- AdminCommand (mcp-interface.md §7)
  args_json      TEXT NOT NULL,                       -- canonical arguments, ≤ 4 KiB; never memory content; deleted 24 h after expiry
  args_sha256    TEXT NOT NULL,
  rendered_text  TEXT NOT NULL,                       -- what the approval page showed, rendered by the server from args_json
  needs_second_confirm INTEGER NOT NULL DEFAULT 0 CHECK (needs_second_confirm IN (0,1)),  -- export to an unregistered recipient
  import_batch_id TEXT,                               -- import tokens are bound to one batch
  uses           INTEGER NOT NULL DEFAULT 0,
  client_id      TEXT NOT NULL,                       -- the PC grant that asked
  user_code      TEXT NOT NULL,                       -- 8 chars, shown in terminal and admin UI
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,                       -- created_at + 5 min
  approved_at    TEXT,
  denied_at      TEXT,
  token_hash     TEXT,                                -- sha256 of issued step-up token
  token_expires_at TEXT
);
CREATE TABLE pairing_window (
  id             TEXT PRIMARY KEY,
  vendor         TEXT NOT NULL,
  method         TEXT NOT NULL CHECK (method IN ('cimd','dcr','static','static_bearer')),
  opened_at      TEXT NOT NULL,
  expires_at     TEXT NOT NULL,                       -- opened_at + 10 min
  pair_code      TEXT NOT NULL,                       -- 8 chars shown in the admin UI (consent fallback)
  pair_cookie_hash TEXT,                              -- sha256 of the __Host-ma_pair cookie set on {host}
  allowed_redirect_host TEXT,                         -- vendor Other: the https host the owner typed
  registered_client_id TEXT,
  granted_at     TEXT,
  closed_at      TEXT,
  close_reason   TEXT                                 -- granted | expired | cancelled | registration_race
);
CREATE TABLE oidc_store (                             -- adapter storage for the OAuth library
  model        TEXT NOT NULL,
  id           TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  grant_id     TEXT,
  uid          TEXT,
  expires_at   TEXT,
  consumed_at  TEXT,
  PRIMARY KEY (model, id)
);
CREATE INDEX oidc_grant ON oidc_store(grant_id);
CREATE INDEX oidc_uid ON oidc_store(uid);
CREATE TABLE grant_meta (
  grant_id      TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES client_policy(client_id),
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);
CREATE TABLE pending_elicitation (                     -- write-path.md §5, mcp-interface.md §5
  id            TEXT PRIMARY KEY,                      -- pel_<ULID>
  grant_id      TEXT NOT NULL,
  tool          TEXT NOT NULL,
  args_sha256   TEXT NOT NULL,
  question      TEXT NOT NULL,                         -- rendered question (quotes ≤ 200 chars of content); deleted at expiry
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,                         -- created_at + 5 min
  consumed_at   TEXT
);
CREATE TABLE export_recipient (                        -- registered age recipients, edited only in the admin UI with a passkey
  id            TEXT PRIMARY KEY,
  recipient     TEXT NOT NULL UNIQUE,                  -- age public key (age1…)
  fingerprint   TEXT NOT NULL,                         -- first 16 hex of sha256(recipient), shown in 4 groups
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE TABLE export_log (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('full','full_auth','projects')),
  recipient_fingerprint TEXT,
  stepup_request_id TEXT,
  client_id     TEXT NOT NULL
);
CREATE TABLE owner_reset (                             -- break-glass, auth-and-security.md §3.3
  id            TEXT PRIMARY KEY,
  requested_at  TEXT NOT NULL,
  effective_at  TEXT NOT NULL,                         -- requested_at + 24 h
  cancelled_at  TEXT,
  executed_at   TEXT
);

-- ===== views (data-model.md §3) =====
-- Current versions of non-deleted memories.
CREATE VIEW current_version AS
SELECT v.* FROM memory_version v
JOIN memory m ON m.id = v.memory_id
WHERE v.valid_to IS NULL AND v.expired_at IS NULL
  AND m.status IN ('active','contested','pending_review');

-- Project catalog (read-only). One row per approved project entity.
-- Each field is a JSON array of {"value", "contested"} objects over current versions of active or contested
-- memories, so a contested pair shows both values and nothing disappears. One-cardinality fields normally hold
-- one element; many-cardinality fields (stack, decisions, constraints, outcomes, portfolio_relevance) hold all.
CREATE VIEW project_field AS
SELECT m.entity_id, a.name AS field, cv.content AS value, (m.status = 'contested') AS contested,
       cv.valid_from, m.id AS memory_id, m.created_at AS recorded_at_sort
FROM memory m
JOIN current_version cv ON cv.memory_id = m.id
JOIN attribute a ON a.id = m.attribute_id
WHERE a.name LIKE 'project.%' AND m.status IN ('active','contested');

CREATE VIEW project_view AS
SELECT e.id AS entity_id,
       e.canonical_name AS name,
       (SELECT json_group_array(al.alias_norm) FROM entity_alias al
          WHERE al.entity_id = e.id AND al.approved = 1 AND al.origin != 'canonical') AS aliases_json,
       (SELECT json_group_array(json_object('field', f.field, 'value', f.value, 'contested', json(CASE WHEN f.contested THEN 'true' ELSE 'false' END),
                                            'memory_id', f.memory_id, 'valid_from', f.valid_from))
          FROM project_field f WHERE f.entity_id = e.id) AS fields_json,
       ea.last_activity_at
FROM entity e LEFT JOIN entity_activity ea ON ea.entity_id = e.id
WHERE e.type = 'project' AND e.status = 'active' AND e.approved = 1;
-- The exporter groups fields_json by field into the shape of §11. `recorded_at_sort` is the memory's created_at.
