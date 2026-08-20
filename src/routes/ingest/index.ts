import { Hono } from "hono";
import type { Env } from "../../worker";
import { ProductsDB, FeedbackDB, CustomersDB } from "../../db/queries";
import type { Product } from "../../db/queries";
import { CRM_ORIGIN, getAuthenticatedFeedbackOrigins } from "../../config/product-origins";
import { assertFirewallSafe, FirewallViolation } from "../../lib/firewall";

const FEEDBACK_TYPES = ["feature_request", "bug", "general"] as const;
type FeedbackType = (typeof FEEDBACK_TYPES)[number];

const router = new Hono<{ Bindings: Env }>();
const MAX_INGEST_BYTES = 32 * 1024;
const MAX_TITLE_CHARS = 160;
const MAX_BODY_CHARS = 5000;
const MAX_EMAIL_CHARS = 254;

interface IngestAccessPolicy {
  allowed: boolean;
  error?: string;
}

type AllowlistParseResult =
  | { ok: true; origins: string[] }
  | { ok: false };

export async function readBoundedFeedbackJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    let reading = true;
    while (reading) {
      const { done, value } = await reader.read();
      if (done) {
        reading = false;
        continue;
      }
      total += value.byteLength;
      if (total > MAX_INGEST_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, error: "feedback payload exceeds 32KB limit" };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsoluteOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

function parseAllowlist(json: string): AllowlistParseResult {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string" && isAbsoluteOrigin(x))) {
      return { ok: true, origins: parsed };
    }
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

// CANON (WS6.1 — public feedback-ingest auth posture): this path is reached DIRECTLY
// by the end user's browser (the feedback-button widget runs in a Shadow DOM on the
// product's authenticated surface and POSTs here under open CORS). It is intentionally
// NOT HMAC-signed: HMAC requires the caller to hold a shared secret, and a browser
// client cannot hold one safely — the same reasoning CLAUDE.md applies to the AI-CS
// worker ("the frontend never holds them"). The defense is therefore layered on what a
// browser CAN prove: Origin present + on the product allowlist + on an AUTHENTICATED
// product surface (AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG), plus a per-(origin,IP) rate
// limit and body/field size caps in the handler. Platform HMAC (X-Ventora-Signature/
// Timestamp/Nonce) is reserved for any future SERVER-TO-SERVER intake (WS6.2), which does
// not exist today; do not add HMAC to this browser path.
export function getIngestAccessPolicy(
  productSlug: string,
  originAllowlistJson: string,
  requestOrigin: string,
): IngestAccessPolicy {
  const allowlistResult = parseAllowlist(originAllowlistJson);
  void productSlug;
  if (!allowlistResult.ok) {
    return { allowed: false, error: "invalid origin allowlist" };
  }
  const allowlist = allowlistResult.origins;
  if (allowlist.length === 0) {
    return { allowed: false, error: "feedback ingest is not enabled for this product" };
  }
  if (!requestOrigin) {
    return { allowed: false, error: "origin required" };
  }
  if (!allowlist.includes(requestOrigin)) {
    return { allowed: false, error: "origin not allowed" };
  }
  if (requestOrigin === CRM_ORIGIN || getAuthenticatedFeedbackOrigins(productSlug).includes(requestOrigin)) {
    return { allowed: true };
  }
  return { allowed: false, error: "feedback ingest is only enabled on authenticated product surfaces" };
}

export function getIngestRateLimitIdentity(origin: string, clientIp: string | null): string {
  return `${origin}|${clientIp ?? "unknown"}`;
}

export async function createFeedbackSubmission(
  db: D1Database,
  product: Product,
  value: unknown,
): Promise<{ ok: true; id: string } | { ok: false; status: 400; error: string }> {
  if (!isJsonObject(value)) {
    return { ok: false, status: 400, error: "feedback body must be a JSON object" };
  }

  const input = value;
  const type = input["type"];
  const title = input["title"];
  const bodyText = input["body"];
  const customerEmail = input["customer_email"];

  if (typeof type !== "string" || !(FEEDBACK_TYPES as readonly string[]).includes(type)) {
    return { ok: false, status: 400, error: "type must be one of: feature_request, bug, general" };
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return { ok: false, status: 400, error: "title is required" };
  }
  if (title.trim().length > MAX_TITLE_CHARS) {
    return { ok: false, status: 400, error: "title must be 160 characters or fewer" };
  }
  if (typeof bodyText === "string" && bodyText.trim().length > MAX_BODY_CHARS) {
    return { ok: false, status: 400, error: "body must be 5000 characters or fewer" };
  }
  if (typeof customerEmail === "string" && customerEmail.trim().length > MAX_EMAIL_CHARS) {
    return { ok: false, status: 400, error: "customer_email must be 254 characters or fewer" };
  }

  let customerId: string | null = null;
  if (typeof customerEmail === "string" && customerEmail.trim().length > 0) {
    const existing = await CustomersDB.getByEmail(db, customerEmail.trim());
    if (existing) {
      try {
        await assertFirewallSafe(db, existing.id, product.id);
        customerId = existing.id;
      } catch (err) {
        if (err instanceof FirewallViolation) {
          customerId = null;
        } else {
          throw err;
        }
      }
    }
  }

  const item = await FeedbackDB.create(db, {
    customer_id: customerId,
    product_id: product.id,
    type: type as FeedbackType,
    title: title.trim(),
    body: typeof bodyText === "string" && bodyText.trim().length > 0 ? bodyText.trim() : null,
    status: "new",
  });

  return { ok: true, id: item.id };
}

router.post("/:productKey", async (c) => {
  const contentLength = c.req.header("Content-Length");
  if (contentLength && Number(contentLength) > MAX_INGEST_BYTES) {
    return c.json({ error: "feedback payload exceeds 32KB limit" }, 413);
  }

  const productKey = c.req.param("productKey");

  const product = await ProductsDB.getByWidgetKey(c.env.DB, productKey);
  if (!product) {
    return c.json({ error: "product not found" }, 404);
  }

  const origin = c.req.header("Origin") ?? "";
  const accessPolicy = getIngestAccessPolicy(product.slug, product.origin_allowlist_json, origin);
  if (!accessPolicy.allowed) {
    return c.json({ error: accessPolicy.error }, 403);
  }

  const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const rateLimitIdentity = getIngestRateLimitIdentity(
    origin,
    c.req.header("CF-Connecting-IP") ?? null,
  );

  const rateRow = await c.env.DB
    .prepare(
      `INSERT INTO ingest_rate_limit (product_id, origin, window_start, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(product_id, origin) DO UPDATE SET
         window_start = excluded.window_start,
         count = CASE
            WHEN ingest_rate_limit.window_start = excluded.window_start
            THEN ingest_rate_limit.count + 1
            ELSE 1
          END
       WHERE ingest_rate_limit.window_start != excluded.window_start
          OR ingest_rate_limit.count < 10
       RETURNING count`,
    )
    .bind(product.id, rateLimitIdentity, windowStart)
    .first<{ count: number }>();

  if (!rateRow) {
    return c.json({ error: "rate limit exceeded" }, 429);
  }

  const parsedBody = await readBoundedFeedbackJson(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({ error: parsedBody.error }, parsedBody.status);
  }
  const result = await createFeedbackSubmission(c.env.DB, product, parsedBody.value);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }

  return c.json({ ok: true, id: result.id }, 201);
});

export default router;
