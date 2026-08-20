/**
 * CAMAudit firewall-group enforcement.
 *
 * We enforce protected product groups at the data layer.
 *
 * Every customer to product link is checked against existing links;
 * if the candidate product and any existing link share a non-null
 * `firewall_group`, the link is rejected.
 *
 * CAMAudit gets `firewall_group = "cre"` at seed time. Retired products are
 * removed before they can participate in active CRM product links. Future
 * firewalled pairs only need to share a `firewall_group` value.
 */

import type { D1Database } from "@cloudflare/workers-types";

export class FirewallViolation extends Error {
  readonly code = "FIREWALL_VIOLATION";
  readonly customerId: string;
  readonly candidateProductId: string;
  readonly conflictingProductId: string;
  readonly firewallGroup: string;
  /** Human-friendly display names, resolved at throw time for the UI. */
  readonly candidateProductName: string;
  readonly conflictingProductName: string;

  constructor(opts: {
    customerId: string;
    candidateProductId: string;
    conflictingProductId: string;
    firewallGroup: string;
    candidateProductName?: string;
    conflictingProductName?: string;
  }) {
    super(
      `Firewall violation: customer ${opts.customerId} is already linked to product ` +
        `${opts.conflictingProductId} in firewall group "${opts.firewallGroup}"; ` +
        `cannot also link to ${opts.candidateProductId}.`,
    );
    this.customerId = opts.customerId;
    this.candidateProductId = opts.candidateProductId;
    this.conflictingProductId = opts.conflictingProductId;
    this.firewallGroup = opts.firewallGroup;
    this.candidateProductName = opts.candidateProductName ?? opts.candidateProductId;
    this.conflictingProductName = opts.conflictingProductName ?? opts.conflictingProductId;
  }

  /**
   * Customer-facing explanation — no UUIDs, slugs, or internal group names.
   * Safe to show directly in the admin UI.
   */
  get userMessage(): string {
    return (
      `${this.candidateProductName} and ${this.conflictingProductName} can’t share a customer — ` +
      `they sit on opposite sides of the same transaction. Keep this customer with one of them.`
    );
  }
}

interface FirewallCheckRow {
  product_id: string;
  product_name: string;
  firewall_group: string;
}

/**
 * Throws FirewallViolation if linking `customerId` to `candidateProductId`
 * would put them in two products that share a non-null firewall_group.
 *
 * Caller must invoke this BEFORE inserting into customer_products. We don't
 * wrap it in a transaction with the insert because D1 statements run in
 * isolation; combine with `run_sql_transaction` upstream if strict atomicity
 * is required.
 */
export async function assertFirewallSafe(
  db: D1Database,
  customerId: string,
  candidateProductId: string,
): Promise<void> {
  const candidateRow = await db
    .prepare("SELECT name, firewall_group FROM products WHERE id = ?")
    .bind(candidateProductId)
    .first<{ name: string; firewall_group: string | null }>();

  if (!candidateRow) {
    throw new Error(`unknown product ${candidateProductId}`);
  }
  if (candidateRow.firewall_group == null) return; // candidate has no firewall constraints

  const conflicts = await db
    .prepare(
      `SELECT DISTINCT p.id AS product_id, p.name AS product_name, p.firewall_group AS firewall_group
         FROM (
           SELECT product_id FROM customer_products WHERE customer_id = ?
           UNION
           SELECT product_id FROM testimonials WHERE customer_id = ?
           UNION
           SELECT product_id FROM reviews WHERE customer_id = ?
           UNION
           SELECT product_id FROM feedback_items WHERE customer_id = ?
         ) associated_products
         JOIN products p ON p.id = associated_products.product_id
        WHERE p.id != ?
          AND p.firewall_group = ?`,
    )
    .bind(customerId, customerId, customerId, customerId, candidateProductId, candidateRow.firewall_group)
    .all<FirewallCheckRow>();

  const firstConflict = conflicts.results?.[0];
  if (firstConflict) {
    throw new FirewallViolation({
      customerId,
      candidateProductId,
      conflictingProductId: firstConflict.product_id,
      firewallGroup: firstConflict.firewall_group,
      candidateProductName: candidateRow.name,
      conflictingProductName: firstConflict.product_name,
    });
  }
}
