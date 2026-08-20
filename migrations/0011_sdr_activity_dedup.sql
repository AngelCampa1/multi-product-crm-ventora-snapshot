-- Migration 0011: add unique constraint on sdr_lead_activities(lead_id, type, occurred_at)
-- to enable idempotent activity append via ON CONFLICT DO NOTHING.
--
-- Rationale: the AI-SDR worker retries the same full request on transient failures
-- and re-extracts across conversation turns, so appendActivity can be called with
-- the same (lead_id, type, occurred_at) triple more than once. Without this
-- constraint every re-push accumulates duplicate rows (e.g. three session_started
-- rows for one lead). With this constraint a repeated append is a silent no-op
-- while genuinely new (type, occurred_at) combinations still land.
--
-- SQLite does not support ADD CONSTRAINT on existing tables; we must use the
-- recommended recreate-rename pattern:
--   1. Create the new table with the constraint.
--   2. Copy data from the old table.
--   3. Drop the old table.
--   4. Rename the new table.
--   5. Recreate the index (was on the old table).

PRAGMA foreign_keys = ON;

CREATE TABLE sdr_lead_activities_new (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL REFERENCES sdr_leads(id) ON DELETE CASCADE,
  type        TEXT NOT NULL
              CHECK (type IN ('session_started', 'qualification_updated', 'message_summary', 'handoff_requested', 'note')),
  payload_json TEXT,
  occurred_at  TEXT NOT NULL,
  UNIQUE (lead_id, type, occurred_at)
);

INSERT INTO sdr_lead_activities_new
  SELECT id, lead_id, type, payload_json, occurred_at
  FROM sdr_lead_activities;

DROP TABLE sdr_lead_activities;

ALTER TABLE sdr_lead_activities_new RENAME TO sdr_lead_activities;

CREATE INDEX idx_sdr_lead_activities_lead_occurred ON sdr_lead_activities(lead_id, occurred_at);
