import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("Playwright e2e config", () => {
  it("allows running the Worker e2e suite on an alternate port", () => {
    const source = readFileSync("playwright.config.ts", "utf8");

    expect(source).toContain("process.env.E2E_PORT");
    expect(source).toContain("parseE2EPort");
    expect(source).toContain("const e2ePort");
    expect(source).toContain("wrangler dev --port ${e2ePort}");
    expect(source).toContain("--test-scheduled");
    expect(source).toContain("CF_ACCESS_JWKS_URL:http://127.0.0.1:18989/certs");
    expect(source).toContain("http://127.0.0.1:${e2ePort}");
  });

  it("runs backend e2e serially against the shared local Worker state", () => {
    const source = readFileSync("playwright.config.ts", "utf8");

    expect(source).toContain("fullyParallel: false");
    expect(source).toContain("workers: 1");
    expect(source).toContain("reuseExistingServer: false");
  });
});
