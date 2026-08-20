import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../../worker";
import { ReviewsDB, CustomersDB, ProductsDB, ConnectorConfigsDB, linkCustomerToProduct, unlinkCustomerFromProduct, cleanupContentCustomerProductLink } from "../../db/queries";
import type { ConnectorConfigSource, Review } from "../../db/queries";
import type { Connector } from "../../connectors/base";
import { dedupAndSave } from "../../connectors/base";
import { manualConnector } from "../../connectors/manual";
import { parseCSV } from "../../connectors/csv";
import { feedReviewSourceError, fetchRSS, parseFeedReviewSource, rssConnector } from "../../connectors/rss";
import { scrapeTrustpilot, trustpilotScrapeConnector } from "../../connectors/scrape-trustpilot";
import { scrapeG2, g2ScrapeConnector } from "../../connectors/scrape-g2";
import { assertFirewallSafe, FirewallViolation } from "../../lib/firewall";
import { pollReviewConnectors } from "../../cron/poll-reviews";

const router = new Hono<{ Bindings: Env }>();
// twitter and other API-backed sources are deferred to v2 and deliberately excluded here;
// omitting them prevents the admin UI from creating connector configs for them.
const CONNECTOR_SOURCES = new Set<ConnectorConfigSource>(["rss", "g2", "trustpilot"]);
const REVIEW_SOURCES = new Set<Review["source"]>([
  "g2",
  "trustpilot",
  "capterra",
  "app_store",
  "play_store",
  "twitter",
  "product_hunt",
  "rss",
  "csv",
  "manual",
]);
const MAX_REVIEW_LIMIT = 200;
const CRON_CONNECTORS: Record<ConnectorConfigSource, Connector> = {
  rss: rssConnector,
  g2: g2ScrapeConnector,
  trustpilot: trustpilotScrapeConnector,
};
const REQUIRED_CONNECTOR_CONFIG_KEYS: Record<ConnectorConfigSource, string> = {
  rss: "feed_url",
  g2: "product_slug",
  trustpilot: "business_unit_id",
};

export function reviewImportErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObjectConfig(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function connectorFetchConfig(config: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, String(value ?? "")]),
  );
}

function validateConnectorConfig(source: ConnectorConfigSource, config: Record<string, unknown>): string | null {
  const requiredKey = REQUIRED_CONNECTOR_CONFIG_KEYS[source];
  const value = config[requiredKey];
  if (typeof value !== "string" || !value.trim()) {
    return `${requiredKey} is required`;
  }
  const trimmed = value.trim();
  if (source === "rss" && !isHttpUrl(trimmed)) {
    return "feed_url must be an absolute http or https URL";
  }
  if (source === "rss" && parseFeedReviewSource(config["review_source"]) === null) {
    return feedReviewSourceError();
  }
  if (source === "g2" && !/^[a-z0-9][a-z0-9-]{0,120}$/i.test(trimmed)) {
    return "product_slug must contain only letters, numbers, and hyphens";
  }
  if (source === "trustpilot" && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(trimmed)) {
    return "business_unit_id must be a valid Trustpilot review path segment";
  }
  if (config["page"] !== undefined) {
    const page = typeof config["page"] === "number" || typeof config["page"] === "string"
      ? Number(config["page"])
      : NaN;
    if (!Number.isInteger(page) || page < 1) {
      return "page must be a positive integer";
    }
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readJsonBody<T>(c: Context<{ Bindings: Env }>): Promise<T | Response> {
  try {
    return await c.req.json<T>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
}

function validateRating(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5) {
    return "rating must be between 1 and 5";
  }
  return null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function positivePage(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function parsePaginationInt(value: string | undefined, fallback: number, min: number, max?: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  const lowerBounded = Math.max(min, parsed);
  return max === undefined ? lowerBounded : Math.min(max, lowerBounded);
}

// ---------------------------------------------------------------------------
// GET / — list reviews
// ---------------------------------------------------------------------------

router.get("/", async (c) => {
  const product_id = c.req.query("product_id");
  const sourceRaw = c.req.query("source");
  const source = sourceRaw as Review["source"] | undefined;
  const limit = parsePaginationInt(c.req.query("limit"), 50, 1, MAX_REVIEW_LIMIT);
  const offset = parsePaginationInt(c.req.query("offset"), 0, 0);

  if (!product_id) {
    return c.json({ error: "product_id is required" }, 400);
  }
  if (sourceRaw !== undefined && !REVIEW_SOURCES.has(sourceRaw as Review["source"])) {
    return c.json({ error: "source must be a valid review source" }, 400);
  }

  const reviews = await ReviewsDB.listByProduct(c.env.DB, product_id, {
    source,
    limit,
    offset,
  });

  // Count with same filters
  const countConditions = ["product_id = ?"];
  const countBindings: unknown[] = [product_id];
  if (source) { countConditions.push("source = ?"); countBindings.push(source); }

  const countRow = await c.env.DB
    .prepare(`SELECT COUNT(*) as n FROM reviews WHERE ${countConditions.join(" AND ")}`)
    .bind(...countBindings)
    .first<{ n: number }>();

  return c.json({ reviews, total: countRow?.n ?? 0 });
});

// ---------------------------------------------------------------------------
// GET /connector-configs — list review connector configs
// ---------------------------------------------------------------------------

router.get("/connector-configs", async (c) => {
  const productId = c.req.query("product_id");
  const configs = productId
    ? await ConnectorConfigsDB.listByProduct(c.env.DB, productId)
    : await ConnectorConfigsDB.list(c.env.DB);

  return c.json({ configs });
});

// ---------------------------------------------------------------------------
// POST /connector-configs — create review connector config
// ---------------------------------------------------------------------------

router.post("/connector-configs", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!isJsonObject(body)) return c.json({ error: "connector config body must be a JSON object" }, 400);
  const input = body;
  const productId = typeof input.product_id === "string" ? input.product_id : "";
  const source = typeof input.source === "string" ? input.source : "";
  if (!productId || !source || !CONNECTOR_SOURCES.has(source as ConnectorConfigSource)) {
    return c.json({ error: "product_id and valid source are required" }, 400);
  }
  if (!isObjectConfig(input.config)) {
    return c.json({ error: "config must be a JSON object" }, 400);
  }
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const configError = validateConnectorConfig(source as ConnectorConfigSource, input.config);
  if (configError) {
    return c.json({ error: configError }, 400);
  }

  const product = await ProductsDB.getById(c.env.DB, productId);
  if (!product) return c.json({ error: "product not found" }, 404);

  const existing = await c.env.DB
    .prepare("SELECT id FROM connector_configs WHERE product_id = ? AND source = ? LIMIT 1")
    .bind(productId, source)
    .first<{ id: string }>();

  const config = await ConnectorConfigsDB.upsert(c.env.DB, {
    product_id: productId,
    source: source as ConnectorConfigSource,
    config: input.config,
    enabled: input.enabled !== false,
  });

  return existing ? c.json(config, 200) : c.json(config, 201);
});

// ---------------------------------------------------------------------------
// PATCH /connector-configs/:id — update review connector config
// ---------------------------------------------------------------------------

router.patch("/connector-configs/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await ConnectorConfigsDB.getById(c.env.DB, id);
  if (!existing) return c.json({ error: "connector config not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (!isJsonObject(body)) return c.json({ error: "connector config body must be a JSON object" }, 400);
  const input = body;
  const productId = typeof input.product_id === "string" ? input.product_id : existing.product_id;
  const source = typeof input.source === "string" ? input.source : existing.source;
  if ("enabled" in input && typeof input.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const enabled = typeof input.enabled === "boolean" ? input.enabled : existing.enabled;
  const config = "config" in input ? input.config : existing.config;

  if (!CONNECTOR_SOURCES.has(source as ConnectorConfigSource)) {
    return c.json({ error: "valid source is required" }, 400);
  }
  if (!isObjectConfig(config)) {
    return c.json({ error: "config must be a JSON object" }, 400);
  }
  const configError = validateConnectorConfig(source as ConnectorConfigSource, config);
  if (configError) {
    return c.json({ error: configError }, 400);
  }

  const product = await ProductsDB.getById(c.env.DB, productId);
  if (!product) return c.json({ error: "product not found" }, 404);

  const updated = await ConnectorConfigsDB.upsert(c.env.DB, {
    id,
    product_id: productId,
    source: source as ConnectorConfigSource,
    config,
    enabled,
  });

  return c.json(updated);
});

// ---------------------------------------------------------------------------
// DELETE /connector-configs/:id
// ---------------------------------------------------------------------------

router.post("/connector-configs/poll-now", async (c) => {
  await pollReviewConnectors(c.env);
  return c.json({ ok: true });
});

router.delete("/connector-configs/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await ConnectorConfigsDB.getById(c.env.DB, id);
  if (!existing) return c.json({ error: "connector config not found" }, 404);

  await ConnectorConfigsDB.delete(c.env.DB, id);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// POST /connector-configs/:id/test-run
// ---------------------------------------------------------------------------

router.post("/connector-configs/:id/test-run", async (c) => {
  const id = c.req.param("id");
  const config = await ConnectorConfigsDB.getById(c.env.DB, id);
  if (!config) return c.json({ error: "connector config not found" }, 404);
  if (!config.enabled) {
    return c.json({ error: "connector config is disabled" }, 400);
  }
  const configError = validateConnectorConfig(config.source, config.config);
  if (configError) {
    return c.json({ error: configError }, 400);
  }

  try {
    const results = await CRON_CONNECTORS[config.source].fetch(connectorFetchConfig(config.config));
    const counts = await dedupAndSave(c.env.DB, config.product_id, results);
    return c.json({ fetched: results.length, ...counts });
  } catch (err) {
    return c.json({ error: reviewImportErrorMessage(err) }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /import/manual
// ---------------------------------------------------------------------------

router.post("/import/manual", async (c) => {
  const parsed = await readJsonBody<{
    product_id: string;
    body: string;
    author_name?: string;
    rating?: number;
    source_url?: string;
  }>(c);
  if (parsed instanceof Response) return parsed;
  if (!isJsonObject(parsed)) return c.json({ error: "review import body must be a JSON object" }, 400);
  const body = parsed;
  const productId = stringField(body, "product_id");
  const reviewBody = stringField(body, "body");

  if (!productId || !reviewBody) {
    return c.json({ error: "product_id and body are required" }, 400);
  }
  const ratingError = validateRating(body.rating);
  if (ratingError) return c.json({ error: ratingError }, 422);

  const product = await ProductsDB.getById(c.env.DB, productId);
  if (!product) return c.json({ error: "product not found" }, 404);

  const results = await manualConnector.fetch({
    body: reviewBody,
    author_name: stringField(body, "author_name"),
    rating: body.rating !== undefined ? String(body.rating) : "",
    source_url: stringField(body, "source_url"),
  });

  const counts = await dedupAndSave(c.env.DB, productId, results);
  return c.json(counts);
});

// ---------------------------------------------------------------------------
// POST /import/csv
// ---------------------------------------------------------------------------

router.post("/import/csv", async (c) => {
  const parsed = await readJsonBody<{ product_id: string; csv_text: string }>(c);
  if (parsed instanceof Response) return parsed;
  if (!isJsonObject(parsed)) return c.json({ error: "review import body must be a JSON object" }, 400);
  const body = parsed;
  const productId = stringField(body, "product_id");
  const csvText = stringField(body, "csv_text");

  if (!productId || !csvText) {
    return c.json({ error: "product_id and csv_text are required" }, 400);
  }

  const product = await ProductsDB.getById(c.env.DB, productId);
  if (!product) return c.json({ error: "product not found" }, 404);

  let results;

  try {
    results = await parseCSV(csvText);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }

  const counts = await dedupAndSave(c.env.DB, productId, results);
  return c.json(counts);
});

// ---------------------------------------------------------------------------
// POST /import/rss
// ---------------------------------------------------------------------------

router.post("/import/rss", async (c) => {
  const parsed = await readJsonBody<{ product_id: string; feed_url: string; review_source?: string }>(c);
  if (parsed instanceof Response) return parsed;
  if (!isJsonObject(parsed)) return c.json({ error: "review import body must be a JSON object" }, 400);
  const body = parsed;
  const productId = stringField(body, "product_id");
  const feedUrl = stringField(body, "feed_url");
  const reviewSource = parseFeedReviewSource(body.review_source);

  if (!productId || !feedUrl) {
    return c.json({ error: "product_id and feed_url are required" }, 400);
  }
  if (!reviewSource) return c.json({ error: feedReviewSourceError() }, 400);
  const rssConfigError = validateConnectorConfig("rss", { feed_url: feedUrl });
  if (rssConfigError) return c.json({ error: rssConfigError }, 400);

  const product = await ProductsDB.getById(c.env.DB, productId);
  if (!product) return c.json({ error: "product not found" }, 404);

  let results;
  try {
    results = await fetchRSS(feedUrl, reviewSource);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }

  const counts = await dedupAndSave(c.env.DB, productId, results);
  return c.json(counts);
});

// ---------------------------------------------------------------------------
// POST /import/trustpilot
// ---------------------------------------------------------------------------

router.post("/import/trustpilot", async (c) => {
  const parsed = await readJsonBody<{ product_id: string; business_unit_id: string; page?: number }>(c);
  if (parsed instanceof Response) return parsed;
  if (!isJsonObject(parsed)) return c.json({ error: "review import body must be a JSON object" }, 400);
  const body = parsed;
  const productId = stringField(body, "product_id");
  const businessUnitId = stringField(body, "business_unit_id");

  if (!productId || !businessUnitId) {
    return c.json({ error: "product_id and business_unit_id are required" }, 400);
  }
  const trustpilotConfigError = validateConnectorConfig("trustpilot", { business_unit_id: businessUnitId, page: body.page });
  if (trustpilotConfigError) return c.json({ error: trustpilotConfigError }, 400);

  const product = await ProductsDB.getById(c.env.DB, productId);
  if (!product) return c.json({ error: "product not found" }, 404);

  let results;
  try {
    results = await scrapeTrustpilot(businessUnitId, positivePage(body.page));
  } catch (err) {
    return c.json({ error: reviewImportErrorMessage(err) }, 400);
  }
  const counts = await dedupAndSave(c.env.DB, productId, results);
  return c.json(counts);
});

// ---------------------------------------------------------------------------
// POST /import/g2
// ---------------------------------------------------------------------------

router.post("/import/g2", async (c) => {
  const parsed = await readJsonBody<{ product_id: string; product_slug: string; page?: number }>(c);
  if (parsed instanceof Response) return parsed;
  if (!isJsonObject(parsed)) return c.json({ error: "review import body must be a JSON object" }, 400);
  const body = parsed;
  const productId = stringField(body, "product_id");
  const productSlug = stringField(body, "product_slug");

  if (!productId || !productSlug) {
    return c.json({ error: "product_id and product_slug are required" }, 400);
  }
  const g2ConfigError = validateConnectorConfig("g2", { product_slug: productSlug, page: body.page });
  if (g2ConfigError) return c.json({ error: g2ConfigError }, 400);

  const product = await ProductsDB.getById(c.env.DB, productId);
  if (!product) return c.json({ error: "product not found" }, 404);

  let results;
  try {
    results = await scrapeG2(productSlug, positivePage(body.page));
  } catch (err) {
    return c.json({ error: reviewImportErrorMessage(err) }, 400);
  }
  const counts = await dedupAndSave(c.env.DB, productId, results);
  return c.json(counts);
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------

router.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await ReviewsDB.getById(c.env.DB, id);

  if (!existing) {
    return c.json({ error: "Review not found" }, 404);
  }

  await ReviewsDB.delete(c.env.DB, id);
  if (existing.customer_id) {
    await cleanupContentCustomerProductLink(c.env.DB, existing.customer_id, existing.product_id);
  }
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// PATCH /:id — link to a customer
// ---------------------------------------------------------------------------

router.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = await readJsonBody<{ customer_id?: string | null }>(c);
  if (parsed instanceof Response) return parsed;
  if (!isJsonObject(parsed)) return c.json({ error: "review body must be a JSON object" }, 400);
  const body = parsed;

  const existing = await ReviewsDB.getById(c.env.DB, id);
  if (!existing) {
    return c.json({ error: "Review not found" }, 404);
  }

  if (body.customer_id !== undefined && body.customer_id !== null && typeof body.customer_id !== "string") {
    return c.json({ error: "customer_id must be a string or null" }, 400);
  }

  const requestedCustomerId = typeof body.customer_id === "string" ? body.customer_id.trim() : body.customer_id;
  if (requestedCustomerId === "") {
    return c.json({ error: "customer_id must be a string or null" }, 400);
  }

  let createdLink = false;
  if (requestedCustomerId !== undefined && requestedCustomerId !== null) {
    const customer = await CustomersDB.getById(c.env.DB, requestedCustomerId);
    if (!customer) {
      return c.json({ error: "customer not found" }, 404);
    }
    try {
      await assertFirewallSafe(c.env.DB, requestedCustomerId, existing.product_id);
    } catch (err) {
      if (err instanceof FirewallViolation) {
        return c.json({ error: err.userMessage, code: "FIREWALL_VIOLATION" }, 422);
      }
      throw err;
    }
    createdLink = await linkCustomerToProduct(c.env.DB, requestedCustomerId, existing.product_id);
  }

  const customer_id =
    requestedCustomerId !== undefined ? requestedCustomerId : existing.customer_id;

  try {
    await c.env.DB
      .prepare("UPDATE reviews SET customer_id = ? WHERE id = ?")
      .bind(customer_id, id)
      .run();
  } catch (err) {
    if (createdLink && requestedCustomerId !== undefined && requestedCustomerId !== null) {
      await unlinkCustomerFromProduct(c.env.DB, requestedCustomerId, existing.product_id);
    }
    throw err;
  }

  if (
    existing.customer_id &&
    (requestedCustomerId === null ||
      (requestedCustomerId !== undefined && requestedCustomerId !== existing.customer_id))
  ) {
    await cleanupContentCustomerProductLink(c.env.DB, existing.customer_id, existing.product_id);
  }

  const updated = await ReviewsDB.getById(c.env.DB, id);
  return c.json(updated);
});

export default router;
