/**
 * SDR lead-ingest HTTP route — Task 1.4 (WS6.2 server-to-server intake).
 *
 * Mounted at /s/ingest/leads in src/worker.ts.
 * Accepts POST /:productKey from the AI-SDR Cloudflare Worker,
 * authenticated with HMAC-SHA256 (X-Ventora-Signature/Timestamp/Nonce).
 *
 * Handler order (per spec):
 *   1. Content-Length pre-check → 413
 *   2. Secret configured guard → 500
 *   3. HMAC header presence check → 401
 *   4. Read bounded body (32KB) → 400 | 413
 *   5. HMAC verify (uses global secret; can run before product lookup) → 401
 *      NOTE: HMAC is verified BEFORE product lookup. The secret is global,
 *      not per-product, so checking it first is possible and preferred:
 *      unauthenticated callers receive 401 without any DB work, and valid
 *      signatures with unknown keys receive 404 — this does not leak
 *      information because the signature itself proves the caller knows the
 *      shared secret already.
 *   6. Product lookup by slug → 404
 *      NOTE: The AI-SDR worker sends the product slug as the :productKey path
 *      segment (the same slug the widget session is initialized with). The CRM
 *      resolves by slug. The HMAC signature already authenticates the caller,
 *      so the opaque widget_public_key is not needed here.
 *   7. Body validation → 400
 *   8. Nonce replay check (ON CONFLICT → 409) → 409
 *   9. Persist (try/catch): upsertCustomer → linkProduct (firewall-safe) → upsertLead → appendActivities
 *  10. Return 200 { customerId, leadId, status }
 */

import { Hono } from "hono";
import type { Env } from "../../worker";
import { ProductsDB } from "../../db/queries";
import { resolveSdrProductSlug } from "../../config/sdr-product-aliases";
import { SdrLeadsDB, type SdrLeadStatus, type SdrLeadActivityType } from "../../db/sdr-leads";
import { verifySdrIngestRequest, DEFAULT_MAX_SKEW_MS, type StableJsonValue } from "../../lib/sdr-hmac";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INGEST_BYTES = 32 * 1024;

const VALID_STATUSES: readonly SdrLeadStatus[] = [
  "new",
  "qualifying",
  "qualified",
  "handoff_requested",
  "accepted",
  "disqualified",
];

const VALID_ACTIVITY_TYPES: readonly SdrLeadActivityType[] = [
  "session_started",
  "qualification_updated",
  "message_summary",
  "handoff_requested",
  "note",
];

// ---------------------------------------------------------------------------
// Bounded body reader (mirrors the pattern in src/routes/ingest/index.ts)
// ---------------------------------------------------------------------------

async function readBoundedJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
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
        return { ok: false, status: 413, error: "payload exceeds 32KB limit" };
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

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Parsed / validated body shape
// ---------------------------------------------------------------------------

export interface ParsedLeadIngest {
  sdrSessionId: string;
  occurredAt: string;
  customer: {
    name: string;
    email: string;
    company: string | null;
    role: string | null;
  };
  lead: {
    status: SdrLeadStatus;
    qualification: Record<string, unknown> | null;
    fitScore: number | null;
    intentScore: number | null;
    utm: Record<string, unknown> | null;
    pageUrl: string | null;
    locale: string | null;
  };
  activities: Array<{
    type: SdrLeadActivityType;
    payload: Record<string, unknown> | null;
  }>;
}

// ---------------------------------------------------------------------------
// Body validator (pure function — exported for unit tests)
// ---------------------------------------------------------------------------

export function validateLeadIngestBody(
  value: unknown,
): { ok: true; value: ParsedLeadIngest } | { ok: false; error: string } {
  if (!isJsonObject(value)) {
    return { ok: false, error: "body must be a JSON object" };
  }

  // --- sdrSessionId ---
  const sdrSessionId = value["sdrSessionId"];
  if (typeof sdrSessionId !== "string" || sdrSessionId.trim().length === 0) {
    return { ok: false, error: "sdrSessionId must be a non-empty string" };
  }

  // --- occurredAt ---
  const occurredAt = value["occurredAt"];
  if (typeof occurredAt !== "string" || occurredAt.trim().length === 0) {
    return { ok: false, error: "occurredAt must be a non-empty string" };
  }

  // --- profile ---
  const profile = value["profile"];
  if (!isJsonObject(profile)) {
    return { ok: false, error: "profile must be a JSON object" };
  }

  // --- profile.contact ---
  const contact = profile["contact"];
  if (!isJsonObject(contact)) {
    return { ok: false, error: "profile.contact must be a JSON object" };
  }

  // email is required — it is the customer's unique key
  const email = contact["email"];
  if (typeof email !== "string" || email.trim().length === 0) {
    return { ok: false, error: "profile.contact.email must be a non-empty string" };
  }

  // name — optional; fall back to the local-part of the email if absent
  const rawName = contact["name"];
  const name: string =
    typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim()
      : email.trim().split("@")[0] ?? email.trim();

  const company =
    typeof contact["company"] === "string" && contact["company"].trim().length > 0
      ? contact["company"].trim()
      : null;

  const role =
    typeof contact["role"] === "string" && contact["role"].trim().length > 0
      ? contact["role"].trim()
      : null;

  // --- profile.fitScore ---
  const fitScore = profile["fitScore"];
  if (fitScore !== undefined && fitScore !== null) {
    if (typeof fitScore !== "number" || fitScore < 0 || fitScore > 1) {
      return { ok: false, error: "fitScore must be a number in [0, 1]" };
    }
  }

  // --- profile.intentScore ---
  const intentScore = profile["intentScore"];
  if (intentScore !== undefined && intentScore !== null) {
    if (typeof intentScore !== "number" || intentScore < 0 || intentScore > 1) {
      return { ok: false, error: "intentScore must be a number in [0, 1]" };
    }
  }

  // --- profile.status ---
  const rawStatus = profile["status"];
  let status: SdrLeadStatus = "new";
  if (rawStatus !== undefined && rawStatus !== null) {
    if (
      typeof rawStatus !== "string" ||
      !(VALID_STATUSES as readonly string[]).includes(rawStatus)
    ) {
      return {
        ok: false,
        error: `profile.status must be one of: ${VALID_STATUSES.join(", ")}`,
      };
    }
    status = rawStatus as SdrLeadStatus;
  }

  // --- profile.qualification ---
  const qualification = profile["qualification"];
  const qualificationOut: Record<string, unknown> | null =
    isJsonObject(qualification) && Object.keys(qualification).length > 0
      ? (qualification as Record<string, unknown>)
      : null;

  // --- profile.derived ---
  const derived = profile["derived"];
  const derivedObj: Record<string, unknown> = isJsonObject(derived)
    ? (derived as Record<string, unknown>)
    : {};

  const utmRaw = derivedObj["utm"];
  const utm: Record<string, unknown> | null = isJsonObject(utmRaw)
    ? (utmRaw as Record<string, unknown>)
    : null;

  const pageUrl: string | null =
    typeof derivedObj["pageUrl"] === "string" ? derivedObj["pageUrl"] : null;

  const locale: string | null =
    typeof derivedObj["locale"] === "string" ? derivedObj["locale"] : null;

  // --- activities ---
  const activities = value["activities"];
  if (!Array.isArray(activities)) {
    return { ok: false, error: "activities must be an array" };
  }

  const parsedActivities: Array<{ type: SdrLeadActivityType; payload: Record<string, unknown> | null }> = [];
  for (let i = 0; i < activities.length; i++) {
    const act = activities[i];
    if (!isJsonObject(act)) {
      return { ok: false, error: `activities[${i}] must be an object` };
    }
    const actType = act["type"];
    if (
      typeof actType !== "string" ||
      !(VALID_ACTIVITY_TYPES as readonly string[]).includes(actType)
    ) {
      return {
        ok: false,
        error: `invalid activity type '${String(actType)}'; must be one of: ${VALID_ACTIVITY_TYPES.join(", ")}`,
      };
    }
    const actPayload = act["payload"];
    parsedActivities.push({
      type: actType as SdrLeadActivityType,
      payload: isJsonObject(actPayload) ? (actPayload as Record<string, unknown>) : null,
    });
  }

  return {
    ok: true,
    value: {
      sdrSessionId: sdrSessionId.trim(),
      occurredAt: occurredAt.trim(),
      customer: {
        name,
        email: email.trim(),
        company,
        role,
      },
      lead: {
        status,
        qualification: qualificationOut,
        fitScore: typeof fitScore === "number" ? fitScore : null,
        intentScore: typeof intentScore === "number" ? intentScore : null,
        utm,
        pageUrl,
        locale,
      },
      activities: parsedActivities,
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Env }>();

router.post("/:productKey", async (c) => {
  // Step 1: Content-Length pre-check (cheapest possible rejection — header only)
  const contentLength = c.req.header("Content-Length");
  if (contentLength !== undefined && Number(contentLength) > MAX_INGEST_BYTES) {
    return c.json({ error: "payload exceeds 32KB limit" }, 413);
  }

  // Step 2: Guard: CRM_INGEST_SECRET must be configured and non-whitespace.
  // Misconfiguration surfaces as 500 rather than silently rejecting as 401.
  // An all-whitespace secret is also invalid and must be caught here.
  if (!c.env.CRM_INGEST_SECRET?.trim()) {
    return c.json({ error: "server misconfiguration" }, 500);
  }

  // Step 3: HMAC header presence check — reject unauthenticated probes before
  // paying the cost of reading the body.
  const signature = c.req.header("X-Ventora-Signature");
  const timestamp = c.req.header("X-Ventora-Timestamp");
  const nonce = c.req.header("X-Ventora-Nonce");
  if (!signature || !timestamp || !nonce) {
    return c.json({ error: "missing authentication headers" }, 401);
  }

  // Step 4: Read bounded body (after auth-header presence is confirmed so that
  // unauthenticated probes never pay the full body-read cost)
  const parsedBody = await readBoundedJson(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({ error: parsedBody.error }, parsedBody.status);
  }

  // Step 5: Verify HMAC (before product lookup — the secret is global, not
  // per-product, so we can authenticate the caller without touching the DB.
  // Unauthenticated callers are rejected cheaply; authenticated callers with
  // an unknown product key receive 404 after this point.)
  const path = new URL(c.req.url).pathname;
  // c.env.CRM_INGEST_SECRET is guaranteed non-empty/non-whitespace here —
  // the guard above (step 2) returns 500 before this point if it is absent or blank.
  const hmacResult = await verifySdrIngestRequest({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    secret: c.env.CRM_INGEST_SECRET!,
    method: "POST",
    path,
    body: parsedBody.value as StableJsonValue,
    signature,
    nonce,
    timestamp,
  });
  if (!hmacResult.ok) {
    // Do NOT include hmacResult.reason in the response — that would leak
    // information about which part of the signature was wrong.
    return c.json({ error: "invalid signature" }, 401);
  }

  // Step 6: Resolve product by slug — the AI-SDR worker sends the product key
  // as the :productKey path segment (the same key the widget session is
  // initialized with, e.g. "grantpipe"). For most products that key already
  // equals the CRM slug; for CAMAudit the AI-SDR key "camaudit" maps to the
  // CRM slug "camaudit-v2", so resolveSdrProductSlug() applies the alias first.
  // The HMAC signature has already authenticated the caller above, so the
  // opaque widget_public_key is not needed here; resolving by slug is both
  // correct and sufficient.
  const productKey = c.req.param("productKey");
  const slug = resolveSdrProductSlug(productKey);
  const product = await ProductsDB.getBySlug(c.env.DB, slug);
  if (!product) {
    return c.json({ error: "unknown product" }, 404);
  }

  // Step 7: Validate body against contract — BEFORE the nonce INSERT so that a
  // request with a valid signature but malformed body does NOT permanently burn
  // its nonce. A legitimate retry under the same nonce must still succeed.
  const validation = validateLeadIngestBody(parsedBody.value);
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400);
  }
  const parsed = validation.value;

  // Step 8: Nonce replay check (atomic ON CONFLICT; check changes===0 → replay).
  // Placed after body validation so bad-body requests never consume a nonce.
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const nonceResult = await c.env.DB
    .prepare(
      `INSERT INTO sdr_ingest_nonce (nonce, seen_at)
       VALUES (?, ?)
       ON CONFLICT(nonce) DO NOTHING`,
    )
    .bind(nonce, nowIso)
    .run();
  if (nonceResult.meta.changes === 0) {
    return c.json({ error: "duplicate request" }, 409);
  }

  // Opportunistic prune: nonces older than the skew window can never be
  // replayed (the HMAC verifier rejects the timestamp before reaching the
  // nonce check), so they are safe to delete. A 60-second safety margin
  // is added to avoid touching nonces that are at the edge of the window.
  // This reuses DEFAULT_MAX_SKEW_MS as the single source of truth — the
  // literal 300_000 is not repeated here. Errors are swallowed intentionally:
  // a failed prune is non-critical and must not abort a successful ingest.
  const PRUNE_SAFETY_MARGIN_MS = 60_000;
  const pruneCutoff = new Date(nowMs - DEFAULT_MAX_SKEW_MS - PRUNE_SAFETY_MARGIN_MS).toISOString();
  try {
    await c.env.DB
      .prepare("DELETE FROM sdr_ingest_nonce WHERE seen_at < ?")
      .bind(pruneCutoff)
      .run();
  } catch {
    // Non-critical: log and continue
    console.warn("sdr-ingest nonce prune failed (non-fatal)");
  }

  // Step 9: Persist — wrapped in try/catch so a D1 failure returns a clean 500
  // with no stack trace or PII in the response body.
  let customer: Awaited<ReturnType<typeof SdrLeadsDB.upsertCustomerByEmail>>;
  let lead: Awaited<ReturnType<typeof SdrLeadsDB.upsertLeadBySession>>;

  try {
    customer = await SdrLeadsDB.upsertCustomerByEmail(c.env.DB, {
      name: parsed.customer.name,
      email: parsed.customer.email,
      company: parsed.customer.company,
      role: parsed.customer.role,
    });

    // Link customer ↔ product through the firewall-safe path.
    // A false return (firewall block or already linked) is tolerated — the lead
    // row still records the product association via product_id.
    await SdrLeadsDB.linkProductFirewallSafe(c.env.DB, customer.id, product.id);

    lead = await SdrLeadsDB.upsertLeadBySession(c.env.DB, {
      customerId: customer.id,
      productId: product.id,
      sdrSessionId: parsed.sdrSessionId,
      status: parsed.lead.status,
      qualification: parsed.lead.qualification,
      fitScore: parsed.lead.fitScore,
      intentScore: parsed.lead.intentScore,
      summary: null, // summary is not in the ingest body contract; the worker derives it separately
      source: "ai-sdr",
      utm: parsed.lead.utm,
      pageUrl: parsed.lead.pageUrl,
      locale: parsed.lead.locale,
    });

    for (const activity of parsed.activities) {
      await SdrLeadsDB.appendActivity(c.env.DB, {
        leadId: lead.id,
        type: activity.type,
        payload: activity.payload,
        occurredAt: parsed.occurredAt,
      });
    }
  } catch (err) {
    // Log non-PII identifiers only — never log email, name, body, or contact fields.
    console.error("sdr-ingest persistence failed", {
      productId: product.id,
      sdrSessionId: parsed.sdrSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "internal error" }, 500);
  }

  // Step 10: Return 200 (spec says 200, not 201)
  return c.json(
    {
      customerId: customer.id,
      leadId: lead.id,
      status: lead.status,
    },
    200,
  );
});

// ---------------------------------------------------------------------------
// Router-level error handler — safety net for any uncaught throw in a handler.
// Logs non-PII context only: path + error message. Never logs body, headers,
// email, names, or contact fields.
// ---------------------------------------------------------------------------
router.onError((err, c) => {
  console.error("sdr-ingest unhandled error", {
    path: new URL(c.req.url).pathname,
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ error: "internal error" }, 500);
});

export default router;
