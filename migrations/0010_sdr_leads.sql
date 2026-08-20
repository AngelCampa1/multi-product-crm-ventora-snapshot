-- SDR lead pipeline tables.
--
-- Conventions (same as 0001_init.sql):
--   * UUIDs as TEXT (generated app-side via crypto.randomUUID()).
--   * Enums encoded as TEXT + CHECK constraint (D1 has no native enum).
--   * Timestamps stored as TEXT in ISO-8601 UTC.
--   * Foreign keys ON DELETE CASCADE where the child row is meaningless
--     without the parent; ON DELETE RESTRICT where orphaning is wrong.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- sdr_leads
--
-- One row per SDR session. sdr_session_id is the idempotency key from the
-- AI-SDR worker so concurrent retries cannot double-insert.
-- ---------------------------------------------------------------------------
CREATE TABLE sdr_leads (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
  sdr_session_id   TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'qualifying', 'qualified', 'handoff_requested', 'accepted', 'disqualified')),
  qualification_json TEXT,
  fit_score          REAL,
  intent_score       REAL,
  summary            TEXT,
  source             TEXT,
  utm_json           TEXT,
  page_url           TEXT,
  locale             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_sdr_leads_product_status ON sdr_leads(product_id, status);
CREATE INDEX idx_sdr_leads_customer ON sdr_leads(customer_id);

-- ---------------------------------------------------------------------------
-- sdr_lead_activities
--
-- Append-only event timeline per lead.
-- ---------------------------------------------------------------------------
CREATE TABLE sdr_lead_activities (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL REFERENCES sdr_leads(id) ON DELETE CASCADE,
  type        TEXT NOT NULL
              CHECK (type IN ('session_started', 'qualification_updated', 'message_summary', 'handoff_requested', 'note')),
  payload_json TEXT,
  occurred_at  TEXT NOT NULL
);

CREATE INDEX idx_sdr_lead_activities_lead_occurred ON sdr_lead_activities(lead_id, occurred_at);

-- ---------------------------------------------------------------------------
-- sdr_ingest_nonce
--
-- Replay protection. One row per nonce; seen_at indexed for time-window pruning.
-- ---------------------------------------------------------------------------
CREATE TABLE sdr_ingest_nonce (
  nonce    TEXT PRIMARY KEY,
  seen_at  TEXT NOT NULL
);

CREATE INDEX idx_sdr_ingest_nonce_seen_at ON sdr_ingest_nonce(seen_at);
