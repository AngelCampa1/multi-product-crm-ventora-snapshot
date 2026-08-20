import type { Env } from "../worker";
import type { Connector } from "../connectors/base";
import { dedupAndSave } from "../connectors/base";
import { rssConnector } from "../connectors/rss";
import { g2ScrapeConnector } from "../connectors/scrape-g2";
import { trustpilotScrapeConnector } from "../connectors/scrape-trustpilot";
import { nowIso } from "../db/queries";

interface ConnectorConfigRow {
  id: string;
  product_id: string;
  source: "rss" | "g2" | "trustpilot";
  config_json: string;
  enabled: number;
}

const CONNECTORS: Record<ConnectorConfigRow["source"], Connector> = {
  rss: rssConnector,
  g2: g2ScrapeConnector,
  trustpilot: trustpilotScrapeConnector,
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateConnectorConfig(source: ConnectorConfigRow["source"], config: Record<string, string>): string | null {
  if (source === "rss") {
    if (!config.feed_url?.trim()) return "feed_url is required";
    if (!isHttpUrl(config.feed_url.trim())) return "feed_url must be an absolute http or https URL";
  }
  if (source === "g2") {
    if (!config.product_slug?.trim()) return "product_slug is required";
    if (!/^[a-z0-9][a-z0-9-]{0,120}$/i.test(config.product_slug.trim())) {
      return "product_slug must contain only letters, numbers, and hyphens";
    }
  }
  if (source === "trustpilot") {
    if (!config.business_unit_id?.trim()) return "business_unit_id is required";
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(config.business_unit_id.trim())) {
      return "business_unit_id must be a valid Trustpilot review path segment";
    }
  }
  if (config.page !== undefined && config.page !== "" && !/^[1-9]\d*$/.test(config.page)) {
    return "page must be a positive integer";
  }
  return null;
}

/**
 * pollReviewConnectors — invoked every 6h by the `scheduled` handler.
 *
 * Reads every enabled row from connector_configs, dispatches to the matching
 * connector, and upserts the deduped results. Per-row failures are logged but
 * do not abort the run — one broken feed shouldn't starve the rest.
 */
export async function pollReviewConnectors(env: Env): Promise<void> {
  let rows: { results: ConnectorConfigRow[] };
  try {
    rows = await env.DB
      .prepare("SELECT id, product_id, source, config_json, enabled FROM connector_configs WHERE enabled = 1")
      .all<ConnectorConfigRow>();
  } catch (err) {
    // Table missing (migration not applied yet) or schema drift — log and exit.
    console.log("poll-reviews: connector_configs unavailable, skipping", err);
    return;
  }

  if (rows.results.length === 0) {
    console.log("poll-reviews: no enabled connector configs");
    return;
  }

  for (const row of rows.results) {
    const connector = CONNECTORS[row.source];
    if (!connector) {
      await recordStatus(env, row.id, "error", `unknown source: ${row.source}`, 0);
      continue;
    }

    let config: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(row.config_json);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config_json must be a JSON object");
      }
      config = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordStatus(env, row.id, "error", `invalid config_json: ${message}`, 0);
      continue;
    }
    const configError = validateConnectorConfig(row.source, config);
    if (configError) {
      await recordStatus(env, row.id, "error", configError, 0);
      continue;
    }

    try {
      const results = await connector.fetch(config);
      const { inserted, errors } = await dedupAndSave(env.DB, row.product_id, results);
      if (errors.length > 0) {
        const message = errors.map((error) => `${error.source}:${error.external_id}: ${error.error}`).join("; ");
        await recordStatus(env, row.id, "error", message, inserted);
        console.log(
          `poll-reviews: ${row.source} product=${row.product_id} partial failure inserted=${inserted} errors=${errors.length}`,
        );
        continue;
      }
      await recordStatus(env, row.id, "ok", null, inserted);
      console.log(
        `poll-reviews: ${row.source} product=${row.product_id} inserted=${inserted} fetched=${results.length}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`poll-reviews: ${row.source} product=${row.product_id} failed: ${message}`);
      await recordStatus(env, row.id, "error", message, 0);
    }
  }
}

async function recordStatus(
  env: Env,
  configId: string,
  status: "ok" | "error",
  error: string | null,
  inserted: number,
): Promise<void> {
  try {
    await env.DB
      .prepare(
        "UPDATE connector_configs SET last_polled_at = ?, last_status = ?, last_error = ?, last_inserted = ? WHERE id = ?",
      )
      .bind(nowIso(), status, error, inserted, configId)
      .run();
  } catch (err) {
    console.log(`poll-reviews: status write failed for ${configId}`, err);
  }
}
