import type { D1Database } from "@cloudflare/workers-types";
import { assertFirewallSafe, FirewallViolation } from "../lib/firewall";
import { CustomersDB, type Customer, generateId, nowIso, linkCustomerToProduct } from "./queries";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type SdrLeadStatus =
  | "new"
  | "qualifying"
  | "qualified"
  | "handoff_requested"
  | "accepted"
  | "disqualified";

export type SdrLeadActivityType =
  | "session_started"
  | "qualification_updated"
  | "message_summary"
  | "handoff_requested"
  | "note";

export interface SdrLead {
  id: string;
  customer_id: string;
  product_id: string;
  sdr_session_id: string;
  status: SdrLeadStatus;
  qualification_json: string | null;
  fit_score: number | null;
  intent_score: number | null;
  summary: string | null;
  source: string | null;
  utm_json: string | null;
  page_url: string | null;
  locale: string | null;
  created_at: string;
  updated_at: string;
}

export interface SdrLeadActivity {
  id: string;
  lead_id: string;
  type: SdrLeadActivityType;
  payload_json: string | null;
  occurred_at: string;
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface UpsertCustomerInput {
  name: string;
  email: string;
  company: string | null;
  role: string | null;
}

export interface UpsertLeadInput {
  customerId: string;
  productId: string;
  sdrSessionId: string;
  status: SdrLeadStatus;
  qualification: Record<string, unknown> | null;
  fitScore: number | null;
  intentScore: number | null;
  summary: string | null;
  source: string | null;
  utm: Record<string, unknown> | null;
  pageUrl: string | null;
  locale: string | null;
}

export interface AppendActivityInput {
  leadId: string;
  type: SdrLeadActivityType;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// SdrLeadsDB
// ---------------------------------------------------------------------------

export const SdrLeadsDB = {
  /**
   * Upsert a customer by email (case-insensitive, trimmed).
   * On insert: lifecycle is set to 'lead'.
   * On conflict: updates name, company, and role without duplicating the row.
   * Composes CustomersDB helpers rather than duplicating SQL.
   */
  async upsertCustomerByEmail(db: D1Database, input: UpsertCustomerInput): Promise<Customer> {
    const email = input.email.trim().toLowerCase();

    const existing = await CustomersDB.getByEmail(db, email);

    if (existing) {
      await CustomersDB.update(db, existing.id, {
        name: input.name,
        company: input.company,
        role: input.role,
      });
      // Re-fetch to get the updated row with the new updated_at.
      const updated = await CustomersDB.getById(db, existing.id);
      if (!updated) throw new Error(`customer ${existing.id} vanished after update`);
      return updated;
    }

    return CustomersDB.create(db, {
      name: input.name,
      email,
      photo_r2_key: null,
      company: input.company,
      role: input.role,
      twitter: null,
      linkedin: null,
      website: null,
      lifecycle: "lead",
      notes: null,
    });
  },

  /**
   * Link customer ↔ product through the firewall-guarded path.
   * Returns true when the link was created, false when already exists OR when
   * the firewall blocks it. Never throws FirewallViolation — callers that need
   * to surface the reason should call assertFirewallSafe directly.
   */
  async linkProductFirewallSafe(
    db: D1Database,
    customerId: string,
    productId: string,
    firewallCheck: typeof assertFirewallSafe = assertFirewallSafe,
  ): Promise<boolean> {
    try {
      return await linkCustomerToProduct(db, customerId, productId, firewallCheck, "content");
    } catch (err) {
      if (err instanceof FirewallViolation) return false;
      throw err;
    }
  },

  /**
   * Idempotent upsert on sdr_session_id. On conflict: updates all mutable
   * fields + updated_at; preserves created_at. Returns the persisted lead row.
   */
  async upsertLeadBySession(db: D1Database, input: UpsertLeadInput): Promise<SdrLead> {
    const id = generateId();
    const now = nowIso();
    const qualJson = input.qualification !== null ? JSON.stringify(input.qualification) : null;
    const utmJson = input.utm !== null ? JSON.stringify(input.utm) : null;

    await db
      .prepare(
        `INSERT INTO sdr_leads (
           id, customer_id, product_id, sdr_session_id, status,
           qualification_json, fit_score, intent_score, summary, source,
           utm_json, page_url, locale, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sdr_session_id) DO UPDATE SET
           status             = excluded.status,
           qualification_json = excluded.qualification_json,
           fit_score          = excluded.fit_score,
           intent_score       = excluded.intent_score,
           summary            = excluded.summary,
           source             = excluded.source,
           utm_json           = excluded.utm_json,
           page_url           = excluded.page_url,
           locale             = excluded.locale,
           updated_at         = excluded.updated_at`,
      )
      .bind(
        id,
        input.customerId,
        input.productId,
        input.sdrSessionId,
        input.status,
        qualJson,
        input.fitScore,
        input.intentScore,
        input.summary,
        input.source,
        utmJson,
        input.pageUrl,
        input.locale,
        now,
        now,
      )
      .run();

    const row = await db
      .prepare("SELECT * FROM sdr_leads WHERE sdr_session_id = ?")
      .bind(input.sdrSessionId)
      .first<SdrLead>();

    if (!row) throw new Error(`sdr_lead upsert failed for session ${input.sdrSessionId}`);
    return row;
  },

  /**
   * Append one immutable activity row to the lead's timeline.
   * payload objects are stringified to payload_json; null stays null.
   *
   * Idempotent: the UNIQUE constraint on (lead_id, type, occurred_at) combined
   * with ON CONFLICT DO NOTHING ensures that re-ingesting the same session
   * (worker retry or re-extraction) does not produce duplicate rows. A genuinely
   * new (type, occurred_at) pair still lands normally.
   */
  async appendActivity(db: D1Database, input: AppendActivityInput): Promise<void> {
    const id = generateId();
    const payloadJson = input.payload !== null ? JSON.stringify(input.payload) : null;

    await db
      .prepare(
        `INSERT INTO sdr_lead_activities (id, lead_id, type, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(lead_id, type, occurred_at) DO NOTHING`,
      )
      .bind(id, input.leadId, input.type, payloadJson, input.occurredAt)
      .run();
  },

  /** Look up a lead by its AI-SDR session id. Returns null if not found. */
  async getLeadBySession(db: D1Database, sdrSessionId: string): Promise<SdrLead | null> {
    return db
      .prepare("SELECT * FROM sdr_leads WHERE sdr_session_id = ?")
      .bind(sdrSessionId)
      .first<SdrLead>();
  },

  /** Look up a lead by its primary key. Returns null if not found. */
  async getLeadById(db: D1Database, id: string): Promise<SdrLead | null> {
    return db
      .prepare("SELECT * FROM sdr_leads WHERE id = ?")
      .bind(id)
      .first<SdrLead>();
  },

  /**
   * Return activities for a lead ordered chronologically (oldest first).
   * payload_json is left as a raw string — callers parse as needed.
   */
  async listActivitiesByLead(db: D1Database, leadId: string): Promise<SdrLeadActivity[]> {
    const result = await db
      .prepare("SELECT * FROM sdr_lead_activities WHERE lead_id = ? ORDER BY occurred_at ASC")
      .bind(leadId)
      .all<SdrLeadActivity>();
    return result.results;
  },

  /**
   * List leads for a product. Optionally filter by status. Default limit 50.
   * Intended for admin reads.
   */
  async listLeadsByProduct(
    db: D1Database,
    productId: string,
    opts: { limit?: number; status?: SdrLeadStatus } = {},
  ): Promise<SdrLead[]> {
    const conditions: string[] = ["product_id = ?"];
    const bindings: unknown[] = [productId];

    if (opts.status) {
      conditions.push("status = ?");
      bindings.push(opts.status);
    }

    const limit = opts.limit ?? 50;
    bindings.push(limit);

    const result = await db
      .prepare(
        `SELECT * FROM sdr_leads WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(...bindings)
      .all<SdrLead>();
    return result.results;
  },

  /**
   * List leads across all products (admin inbox). Optionally filter by
   * productId and/or status. Includes product_slug and product_name from a
   * LEFT JOIN. Returns at most `limit` rows starting from `offset`.
   */
  async listLeads(
    db: D1Database,
    opts: {
      productId?: string;
      status?: SdrLeadStatus;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<(SdrLead & { product_slug: string | null; product_name: string | null })[]> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (opts.productId) {
      conditions.push("l.product_id = ?");
      bindings.push(opts.productId);
    }
    if (opts.status) {
      conditions.push("l.status = ?");
      bindings.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    bindings.push(limit, offset);

    const result = await db
      .prepare(
        `SELECT l.*, p.slug AS product_slug, p.name AS product_name
         FROM sdr_leads l
         LEFT JOIN products p ON p.id = l.product_id
         ${where}
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings)
      .all<SdrLead & { product_slug: string | null; product_name: string | null }>();
    return result.results;
  },

  /**
   * Count of leads matching optional productId / status filters.
   * Used alongside listLeads to return a total for pagination.
   */
  async countLeads(
    db: D1Database,
    opts: { productId?: string; status?: SdrLeadStatus } = {},
  ): Promise<number> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (opts.productId) {
      conditions.push("product_id = ?");
      bindings.push(opts.productId);
    }
    if (opts.status) {
      conditions.push("status = ?");
      bindings.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM sdr_leads ${where}`)
      .bind(...bindings)
      .first<{ n: number }>();
    return row?.n ?? 0;
  },
};
