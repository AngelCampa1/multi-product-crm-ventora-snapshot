export const CRM_ORIGIN = "https://crm.ventoralabs.com";

export const PRODUCT_ORIGINS_BY_SLUG = {
  "camaudit-v2": [CRM_ORIGIN, "https://camaudit.io", "https://www.camaudit.io", "https://app.camaudit.io"],
  "floriva-web": [CRM_ORIGIN, "https://floriva.app", "https://www.floriva.app"],
  "grantpipe": [CRM_ORIGIN, "https://grantpipe.com", "https://www.grantpipe.com", "https://app.grantpipe.com"],
  "ventora-crm": [CRM_ORIGIN],
} as const satisfies Record<string, readonly string[]>;

export const PRODUCT_BRAND_COLORS_BY_SLUG = {
  "camaudit-v2": "#0f4c81",
  "floriva-web": "#be185d",
  "grantpipe": "#16a34a",
  "ventora-crm": "#4f46e5",
} as const satisfies Record<keyof typeof PRODUCT_ORIGINS_BY_SLUG, string>;

// Origins where the feedback-button widget is allowed to run. Feedback is collected ONLY from
// authenticated product surfaces (the authenticated app surface — `app.`/`my.` subdomains, or the apex where the app runs there), never from public marketing pages —
// this keeps anonymous/marketing traffic out of the customer feedback inbox and aligns with the
// authenticated-surface privacy posture. `floriva-web` is DELIBERATELY omitted: it
// exposes only public marketing origins (floriva.app + www) with no authenticated app
// surface, so the feedback button stays disabled for them by design (see getOriginPolicy).
export const AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG = {
  "camaudit-v2": ["https://app.camaudit.io"],
  "grantpipe": ["https://app.grantpipe.com"],
} as const satisfies Partial<Record<keyof typeof PRODUCT_ORIGINS_BY_SLUG, readonly string[]>>;

export function getAuthenticatedFeedbackOrigins(productSlug: string): readonly string[] {
  const originsBySlug: Partial<Record<string, readonly string[]>> = AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG;
  return originsBySlug[productSlug] ?? [];
}
