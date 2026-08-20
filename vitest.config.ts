import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Scope coverage to files actually exercised by unit tests. auth.ts and cache.ts
      // depend on Workers-runtime globals (caches, crypto.subtle) not available in node;
      // they are covered by integration tests against wrangler dev instead.
      include: [
        "src/lib/firewall.ts",
        "src/lib/sdr-hmac.ts",
        "src/widgets/feedback-button.ts",
        "src/db/sdr-leads.ts",
        "src/config/sdr-product-aliases.ts",
        "src/routes/sdr-ingest/index.ts",
        "src/routes/admin/sdr-leads.ts",
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
