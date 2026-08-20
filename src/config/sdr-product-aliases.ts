/**
 * AI-SDR → CRM product-key aliases.
 *
 * The AI-SDR pipeline identifies each product by an immutable "product key"
 * that is baked into the widget bootstrap, the AI-SDR signing worker, the
 * frontend BFF context-signing map, and the sibling product workers. The CRM,
 * however, stores products under a `slug`, and for one product that slug does
 * not match the AI-SDR key:
 *
 *   AI-SDR key  →  CRM slug
 *   "camaudit"  →  "camaudit-v2"   (the CRM slug carries a repo-name artifact)
 *
 * The ingest route receives the AI-SDR key as the `:productKey` path segment
 * and must resolve the CRM product by slug. This map bridges the two naming
 * worlds at that single boundary so a CAMAudit lead is not silently dropped
 * with a 404. It is additive and reversible: renaming the CRM slug to
 * "camaudit" later would simply make this entry a no-op.
 *
 * Every product whose AI-SDR key already equals its CRM slug needs NO entry —
 * `resolveSdrProductSlug` passes unknown keys through unchanged.
 */
export const SDR_PRODUCT_KEY_ALIASES: Record<string, string> = {
  camaudit: "camaudit-v2",
};

/**
 * Resolve an incoming AI-SDR product key to the CRM product slug used by
 * `ProductsDB.getBySlug`. Returns the alias when one exists, otherwise the
 * original key unchanged.
 */
export function resolveSdrProductSlug(productKey: string): string {
  return SDR_PRODUCT_KEY_ALIASES[productKey] ?? productKey;
}
