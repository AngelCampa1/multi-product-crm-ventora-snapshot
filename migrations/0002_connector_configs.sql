-- connector_configs — per-product review-poller config.
--
-- Read every 6h by the scheduled handler (src/cron/poll-reviews.ts). Each row
-- describes one external feed for one product. config_json is a JSON object
-- whose shape depends on the source (e.g. {"feed_url":"..."} for rss).
--
-- Only "fetch from remote" sources are pollable from cron — csv/manual run
-- on-demand through the admin UI, not on a schedule.

CREATE TABLE connector_configs (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source          TEXT NOT NULL
                  CHECK (source IN ('rss', 'g2', 'trustpilot')),
  config_json     TEXT NOT NULL DEFAULT '{}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_polled_at  TEXT,
  last_status     TEXT,                     -- 'ok' | 'error'
  last_error      TEXT,
  last_inserted   INTEGER,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_connector_configs_product ON connector_configs(product_id);
CREATE INDEX idx_connector_configs_enabled ON connector_configs(enabled) WHERE enabled = 1;
