/**
 * Admin SDR leads router — /api/admin/sdr-leads
 *
 * Read-only router. Mounted behind requireAccess + requireAdminMutationProtection
 * in worker.ts. No auth is applied here; it is inherited from the mount.
 *
 * Endpoints:
 *   GET /          — list leads (paginated), optional product_id / status filters
 *   GET /:id       — lead detail with customer + activities; JSON columns parsed
 */

import { Hono } from "hono";
import type { Env } from "../../worker";
import { SdrLeadsDB, type SdrLeadStatus } from "../../db/sdr-leads";
import { CustomersDB } from "../../db/queries";

const router = new Hono<{ Bindings: Env }>();

const MAX_LEAD_LIMIT = 200;

const VALID_LEAD_STATUSES = new Set<SdrLeadStatus>([
  "new",
  "qualifying",
  "qualified",
  "handoff_requested",
  "accepted",
  "disqualified",
]);

function parsePaginationInt(value: string, fallback: number, min: number, max?: number): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const lowerBounded = Math.max(min, parsed);
  return max === undefined ? lowerBounded : Math.min(max, lowerBounded);
}

function safeParseJson(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET / — list leads
// Query params: product_id?, status?, limit (default 50, max 200), offset (default 0)
// Returns { items: (SdrLead & { product_slug, product_name })[], total: number }
// customer_id is included from the lead row; customer name/email are NOT joined
// (the list is lean — detail endpoint provides full customer context).
// ---------------------------------------------------------------------------
router.get("/", async (c) => {
  const { product_id, status, limit = "50", offset = "0" } = c.req.query();

  if (status && !VALID_LEAD_STATUSES.has(status as SdrLeadStatus)) {
    return c.json({ error: "invalid lead status" }, 400);
  }

  const limitInt = parsePaginationInt(limit, 50, 1, MAX_LEAD_LIMIT);
  const offsetInt = parsePaginationInt(offset, 0, 0);

  const [items, total] = await Promise.all([
    SdrLeadsDB.listLeads(c.env.DB, {
      productId: product_id,
      status: status ? (status as SdrLeadStatus) : undefined,
      limit: limitInt,
      offset: offsetInt,
    }),
    SdrLeadsDB.countLeads(c.env.DB, {
      productId: product_id,
      status: status ? (status as SdrLeadStatus) : undefined,
    }),
  ]);

  return c.json({ items, total });
});

// ---------------------------------------------------------------------------
// GET /:id — lead detail
// Returns {
//   lead: SdrLead & { qualification: object|null, utm: object|null },
//   customer: Customer | null,
//   activities: (SdrLeadActivity & { payload: object|null })[],
// }
// ---------------------------------------------------------------------------
router.get("/:id", async (c) => {
  const lead = await SdrLeadsDB.getLeadById(c.env.DB, c.req.param("id"));
  if (!lead) return c.json({ error: "not found" }, 404);

  const [activities, customer] = await Promise.all([
    SdrLeadsDB.listActivitiesByLead(c.env.DB, lead.id),
    CustomersDB.getById(c.env.DB, lead.customer_id),
  ]);

  const leadWithParsed = {
    ...lead,
    qualification: safeParseJson(lead.qualification_json),
    utm: safeParseJson(lead.utm_json),
  };

  const activitiesWithParsed = activities.map((a) => ({
    ...a,
    payload: safeParseJson(a.payload_json),
  }));

  // customer_id has ON DELETE CASCADE so a missing customer means the lead was
  // also cascade-deleted and getLeadById above would have returned null. In
  // practice customer is always non-null here, but we return it verbatim from
  // CustomersDB.getById so the type is Customer | null.
  return c.json({
    lead: leadWithParsed,
    customer,
    activities: activitiesWithParsed,
  });
});

export default router;
