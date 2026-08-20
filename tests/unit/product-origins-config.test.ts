import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG,
  PRODUCT_BRAND_COLORS_BY_SLUG,
  PRODUCT_ORIGINS_BY_SLUG,
} from "../../src/config/product-origins";

describe("product origin rollout config", () => {
  it("does not configure retired product origins or brand colors", () => {
    const retiredSlugs = ["retired-product-01", "retired-product-02", "retired-product-03", "retired-product-04", "retired-product-05", "retired-product-06", "retired-product-07", "retired-product-08", "retired-product-09"];
    const retiredOrigins = [
      "https://retired-product-01.com",
      "https://www.retired-product-01.com",
      "https://app.retired-product-01.com",
      "https://retired-product-02.club",
      "https://www.retired-product-02.club",
      "https://app.retired-product-02.club",
      "https://retired-product-03.app",
      "https://retired-product-04.app",
      "https://my.retired-product-04.app",
      "https://retired-product-05.io",
      "https://www.retired-product-05.io",
      "https://app.retired-product-05.io",
      "https://retired-product-06.app",
      "https://my.retired-product-06.app",
      "https://retired-product-07-brand.app",
      "https://my.retired-product-07-brand.app",
      "https://retired-product-08.app",
      "https://my.retired-product-08.app",
      "https://app.retired-product-08.app",
      "https://retired-product-09.app",
      "https://www.retired-product-09.app",
      "https://app.retired-product-09.app",
    ];

    for (const slug of retiredSlugs) {
      expect(PRODUCT_ORIGINS_BY_SLUG).not.toHaveProperty(slug);
      expect(PRODUCT_BRAND_COLORS_BY_SLUG).not.toHaveProperty(slug);
      expect(AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG).not.toHaveProperty(slug);
    }
    expect(Object.values(PRODUCT_ORIGINS_BY_SLUG).flat()).not.toEqual(expect.arrayContaining(retiredOrigins));
  });

  it.each([
    ["camaudit-v2", "https://camaudit.io"],
    ["camaudit-v2", "https://app.camaudit.io"],
    ["grantpipe", "https://app.grantpipe.com"],
    ["floriva-web", "https://floriva.app"],
  ])("includes %s live origin %s", (_slug, origin) => {
    expect(Object.values(PRODUCT_ORIGINS_BY_SLUG).some((origins: readonly string[]) => origins.includes(origin))).toBe(true);
  });

  it("does not allow the stale retired-product-05.ai domain", () => {
    expect(Object.values(PRODUCT_ORIGINS_BY_SLUG).flat()).not.toContain("https://retired-product-05.ai");
    expect(Object.values(PRODUCT_ORIGINS_BY_SLUG).flat()).not.toContain("https://www.retired-product-05.ai");
  });

  it("has brand colors for every configured product", () => {
    expect(Object.keys(PRODUCT_BRAND_COLORS_BY_SLUG).sort()).toEqual(Object.keys(PRODUCT_ORIGINS_BY_SLUG).sort());
  });

  it("keeps feedback app origins inside each product origin allowlist", () => {
    for (const [slug, feedbackOrigins] of Object.entries(AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG)) {
      const productOrigins = PRODUCT_ORIGINS_BY_SLUG[slug as keyof typeof PRODUCT_ORIGINS_BY_SLUG];
      expect(productOrigins, `${slug} must have product origins`).toBeDefined();
      for (const origin of feedbackOrigins) {
        expect(productOrigins, `${slug} must include ${origin}`).toContain(origin);
      }
    }
  });
});
