/**
 * Unit tests for the AI-SDR → CRM product-key alias resolver.
 *
 * The AI-SDR widget/worker identifies CAMAudit by the immutable product key
 * "camaudit" (shared across the AI-SDR signing worker, the BFF context-signing
 * map, and three sibling product workers). The CRM, however, stores that
 * product under the slug "camaudit-v2" (a repo-name artifact). Without an
 * alias, ProductsDB.getBySlug("camaudit") returns null and every CAMAudit lead
 * 404s at the ingest boundary.
 *
 * resolveSdrProductSlug() bridges the two: it maps known AI-SDR keys to their
 * CRM slug and passes every other key through unchanged.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSdrProductSlug,
  SDR_PRODUCT_KEY_ALIASES,
} from "../../src/config/sdr-product-aliases";

describe("resolveSdrProductSlug", () => {
  it("maps the AI-SDR key 'camaudit' to the CRM slug 'camaudit-v2'", () => {
    expect(resolveSdrProductSlug("camaudit")).toBe("camaudit-v2");
  });

  it("passes through a key that has no alias unchanged", () => {
    expect(resolveSdrProductSlug("grantpipe")).toBe("grantpipe");
    expect(resolveSdrProductSlug("floriva-web")).toBe("floriva-web");
  });

  it("passes through an already-correct CRM slug unchanged", () => {
    // Defensive: if a caller ever sends the canonical slug directly, aliasing
    // it again must not double-map or break it.
    expect(resolveSdrProductSlug("camaudit-v2")).toBe("camaudit-v2");
  });

  it("passes through an unknown key unchanged (no implicit failure)", () => {
    expect(resolveSdrProductSlug("totally-unknown-product")).toBe(
      "totally-unknown-product",
    );
  });

  it("exposes the alias table for auditability and keys it by the AI-SDR key", () => {
    expect(SDR_PRODUCT_KEY_ALIASES.camaudit).toBe("camaudit-v2");
  });
});
