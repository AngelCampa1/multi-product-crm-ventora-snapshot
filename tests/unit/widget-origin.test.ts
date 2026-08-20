import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { getOriginPolicy, resolveCrmOrigin } from "../../src/routes/widget/index";
import { getIngestAccessPolicy, getIngestRateLimitIdentity } from "../../src/routes/ingest/index";
import { AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG, PRODUCT_ORIGINS_BY_SLUG } from "../../src/config/product-origins";

describe("widget origin policy", () => {
  it("allows empty allowlists for public widget reads", () => {
    expect(getOriginPolicy("grantpipe", "wall-grid", "[]", "https://example.com")).toEqual({ allowed: true });
  });

  it("rejects widget reads from origins outside a configured allowlist", () => {
    expect(getOriginPolicy("grantpipe", "wall-grid", "[\"https://allowed.example\"]", "https://blocked.example")).toEqual({
      allowed: false,
      error: "origin not allowed",
    });
  });

  it("rejects widget reads without an Origin when an allowlist is configured", () => {
    expect(getOriginPolicy("grantpipe", "wall-grid", "[\"https://allowed.example\"]", "")).toEqual({
      allowed: false,
      error: "origin required",
    });
  });

  it("fails closed when a product has a malformed widget origin allowlist", () => {
    expect(getOriginPolicy("grantpipe", "wall-grid", "{bad", "https://allowed.example")).toEqual({
      allowed: false,
      error: "invalid origin allowlist",
    });
    expect(getOriginPolicy("grantpipe", "wall-grid", "{\"origin\":\"https://allowed.example\"}", "https://allowed.example")).toEqual({
      allowed: false,
      error: "invalid origin allowlist",
    });
    expect(getOriginPolicy("grantpipe", "wall-grid", "[123]", "https://allowed.example")).toEqual({
      allowed: false,
      error: "invalid origin allowlist",
    });
    expect(getOriginPolicy("grantpipe", "wall-grid", "[\"https://allowed.example\",123]", "https://allowed.example")).toEqual({
      allowed: false,
      error: "invalid origin allowlist",
    });
    expect(getOriginPolicy("grantpipe", "wall-grid", "[\"https://allowed.example/path\"]", "https://allowed.example")).toEqual({
      allowed: false,
      error: "invalid origin allowlist",
    });
  });

  it("allows public wall widgets from configured marketing origins", () => {
    expect(getOriginPolicy(
      "grantpipe",
      "wall-grid",
      "[\"https://grantpipe.com\",\"https://app.grantpipe.com\"]",
      "https://grantpipe.com",
    )).toEqual({ allowed: true });
  });

  it("rejects feedback widgets from configured marketing origins", () => {
    expect(getOriginPolicy(
      "grantpipe",
      "feedback-button",
      "[\"https://grantpipe.com\",\"https://app.grantpipe.com\"]",
      "https://grantpipe.com",
    )).toEqual({
      allowed: false,
      error: "feedback widget is only enabled on authenticated product surfaces",
    });
  });

  it("allows feedback widgets from configured authenticated origins", () => {
    expect(getOriginPolicy(
      "grantpipe",
      "feedback-button",
      "[\"https://grantpipe.com\",\"https://app.grantpipe.com\"]",
      "https://app.grantpipe.com",
    )).toEqual({ allowed: true });
  });

  it("rejects feedback widgets when product ingest is disabled by an empty allowlist", () => {
    expect(getOriginPolicy(
      "grantpipe",
      "feedback-button",
      "[]",
      "https://app.grantpipe.com",
    )).toEqual({
      allowed: false,
      error: "feedback widget is not enabled for this product",
    });
  });

  it("rejects feedback widgets without Origin even when an allowlist contains CRM", () => {
    expect(getOriginPolicy(
      "grantpipe",
      "feedback-button",
      "[\"https://crm.ventoralabs.com\",\"https://app.grantpipe.com\"]",
      "",
    )).toEqual({ allowed: false, error: "origin required" });
  });

  it("allows feedback widgets from every configured authenticated app origin", () => {
    for (const [slug, feedbackOrigins] of Object.entries(AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG)) {
      for (const origin of feedbackOrigins) {
        expect(getOriginPolicy(
          slug,
          "feedback-button",
          JSON.stringify(PRODUCT_ORIGINS_BY_SLUG[slug as keyof typeof PRODUCT_ORIGINS_BY_SLUG]),
          origin,
        ), `${slug} ${origin}`).toEqual({ allowed: true });
      }
    }
  });
});

describe("resolveCrmOrigin", () => {
  it("forces https for a real host so embedded widgets never hit a mixed-content endpoint", () => {
    expect(resolveCrmOrigin("http://crm.ventoralabs.com/w/data/x/feedback-button")).toBe(
      "https://crm.ventoralabs.com",
    );
  });

  it("keeps https when already https", () => {
    expect(resolveCrmOrigin("https://crm.ventoralabs.com/w/data/x/feedback-button")).toBe(
      "https://crm.ventoralabs.com",
    );
  });

  it("preserves the http scheme and port for localhost dev", () => {
    expect(resolveCrmOrigin("http://localhost:8787/w/data/x/feedback-button")).toBe(
      "http://localhost:8787",
    );
    expect(resolveCrmOrigin("http://127.0.0.1:8787/w/data/x/feedback-button")).toBe(
      "http://127.0.0.1:8787",
    );
  });
});

describe("ingest access policy", () => {
  it("disables public ingest until an allowlist is configured", () => {
    expect(getIngestAccessPolicy("grantpipe", "[]", "https://example.com")).toEqual({
      allowed: false,
      error: "feedback ingest is not enabled for this product",
    });
  });

  it("requires a browser origin for public ingest", () => {
    expect(getIngestAccessPolicy("grantpipe", "[\"https://allowed.example\"]", "")).toEqual({
      allowed: false,
      error: "origin required",
    });
  });

  it("fails closed when ingest allowlists contain malformed entries", () => {
    expect(getIngestAccessPolicy("grantpipe", "[\"https://app.grantpipe.com\",123]", "https://app.grantpipe.com")).toEqual({
      allowed: false,
      error: "invalid origin allowlist",
    });
    expect(getIngestAccessPolicy("grantpipe", "[\"not an origin\"]", "https://app.grantpipe.com")).toEqual({
      allowed: false,
      error: "invalid origin allowlist",
    });
  });

  it("allows feedback ingest from CRM preview surfaces", () => {
    expect(getIngestAccessPolicy("grantpipe", "[\"https://crm.ventoralabs.com\"]", "https://crm.ventoralabs.com")).toEqual({
      allowed: true,
    });
  });

  it("allows feedback ingest from configured authenticated app origins", () => {
    expect(getIngestAccessPolicy(
      "grantpipe",
      "[\"https://grantpipe.com\",\"https://app.grantpipe.com\"]",
      "https://app.grantpipe.com",
    )).toEqual({ allowed: true });
  });

  it("rejects feedback ingest from configured marketing origins", () => {
    expect(getIngestAccessPolicy(
      "grantpipe",
      "[\"https://grantpipe.com\",\"https://www.grantpipe.com\",\"https://app.grantpipe.com\"]",
      "https://grantpipe.com",
    )).toEqual({
      allowed: false,
      error: "feedback ingest is only enabled on authenticated product surfaces",
    });
  });

  it("allows feedback ingest from every configured authenticated app origin", () => {
    for (const [slug, feedbackOrigins] of Object.entries(AUTHENTICATED_FEEDBACK_ORIGINS_BY_SLUG)) {
      for (const origin of feedbackOrigins) {
        expect(getIngestAccessPolicy(
          slug,
          JSON.stringify(PRODUCT_ORIGINS_BY_SLUG[slug as keyof typeof PRODUCT_ORIGINS_BY_SLUG]),
          origin,
        ), `${slug} ${origin}`).toEqual({ allowed: true });
      }
    }
  });
});

describe("ingest rate limit identity", () => {
  it("uses Cloudflare connecting IP with origin when present", () => {
    expect(getIngestRateLimitIdentity("https://allowed.example", "203.0.113.7")).toBe(
      "https://allowed.example|203.0.113.7",
    );
  });

  it("uses the unknown sentinel when no IP is provided (CF-Connecting-IP absent)", () => {
    expect(getIngestRateLimitIdentity("https://allowed.example", null)).toBe(
      "https://allowed.example|unknown",
    );
  });

  it("two requests with different X-Forwarded-For but no CF-Connecting-IP produce the same identity", () => {
    // Both get null as the IP argument — XFF must never be passed to this helper
    const identity1 = getIngestRateLimitIdentity("https://allowed.example", null);
    const identity2 = getIngestRateLimitIdentity("https://allowed.example", null);
    expect(identity1).toBe(identity2);
  });

  it("two requests with different CF-Connecting-IP values produce distinct identities", () => {
    const identity1 = getIngestRateLimitIdentity("https://allowed.example", "1.2.3.4");
    const identity2 = getIngestRateLimitIdentity("https://allowed.example", "5.6.7.8");
    expect(identity1).not.toBe(identity2);
  });

  it("uses a conditional upsert so concurrent ingest requests cannot exceed the per-window cap", () => {
    const source = readFileSync("src/routes/ingest/index.ts", "utf8");

    expect(source).toContain("ON CONFLICT(product_id, origin) DO UPDATE SET");
    expect(source).toContain("ingest_rate_limit.count < 10");
    expect(source).toContain("RETURNING count");
    expect(source).not.toContain("SELECT count FROM ingest_rate_limit");
  });
});

describe("widget loader", () => {
  it("binds each loader execution to document.currentScript before falling back", () => {
    const source = readFileSync("src/routes/widget/index.ts", "utf8");

    expect(source).toContain("document.currentScript");
    expect(source).toContain("currentScript.getAttribute");
  });
});
