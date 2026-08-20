import { readFileSync, readdirSync } from "fs";
import { describe, expect, it } from "vitest";

describe("product seeding script", () => {
  const retiredSlugs = ["retired-product-01", "retired-product-02", "retired-product-03", "retired-product-04", "retired-product-05", "retired-product-06", "retired-product-07", "retired-product-08", "retired-product-09"];

  it("excludes retired products and deletes any existing rows for them", () => {
    const script = readFileSync("scripts/seed-products.ts", "utf8");

    expect(script).toContain("RETIRED_PRODUCT_SLUGS");
    for (const slug of retiredSlugs) {
      expect(script).toContain(`"${slug}"`);
      expect(script).not.toContain(`slug: "${slug}"`);
    }
    expect(script).toContain("RETIRED_PRODUCT_SLUGS");
    expect(script).not.toContain("DELETE FROM testimonials WHERE product_id");
    expect(script).not.toContain("DELETE FROM feedback_items WHERE product_id");
    expect(script).not.toContain("DELETE FROM reviews WHERE product_id");
    expect(script).not.toContain('slug === "retired-product-01"');
  });

  it("uses a dedicated retired-product cleanup script with preflight and post-delete verification", () => {
    const script = readFileSync("scripts/remove-retired-products.ts", "utf8");

    expect(script).toContain("Retired product cleanup preflight");
    expect(script).toContain("getRetiredProductCounts");
    expect(script).toContain("getRemainingRetiredProductSlugs");
    expect(script).toContain("DELETE FROM tag_links");
    expect(script).toContain("item_type = 'testimonial'");
    expect(script).toContain("item_type = 'feedback'");
    expect(script).toContain("item_type = 'review'");
    expect(script).toContain("DELETE FROM testimonials");
    expect(script).toContain("DELETE FROM feedback_items");
    expect(script).toContain("DELETE FROM reviews");
    expect(script).toContain("DELETE FROM products");
    expect(script).toContain("Retired product rows still exist after cleanup");
  });

  it("does not keep checked-in product fixtures for retired products", () => {
    const fixtureFiles = readdirSync("tests/fixtures/products");

    for (const slug of retiredSlugs) {
      expect(fixtureFiles).not.toContain(`${slug}.md`);
    }
  });

  it("does not overwrite regenerated widget public keys on upsert", () => {
    const script = readFileSync("scripts/seed-products.ts", "utf8");

    expect(script).toContain("widget_public_key");
    expect(script).toContain("randomblob(16)");
    expect(script).not.toContain("djb2");
    expect(script).not.toMatch(/widget_public_key\s*=\s*excluded\.widget_public_key/);
  });

  it("wraps local D1 seed statements in a transaction but avoids remote transaction SQL", () => {
    const script = readFileSync("scripts/seed-products.ts", "utf8");

    expect(script).toContain("BEGIN TRANSACTION");
    expect(script).toContain("COMMIT");
    expect(script).toContain("statements.join");
    expect(script).toContain("if (remote)");
    expect(script).toContain("runSql(buildSeedSql(rows, REMOTE))");
  });
});

describe("production deploy scripts", () => {
  it("uses a staged production rollout instead of applying all remote migrations before deploy", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const deployRollout = pkg.scripts["deploy:rollout"];
    const retiredCleanup = pkg.scripts["deploy:retired-products:cleanup"];

    expect(pkg.scripts.deploy).toBe("npm run deploy:rollout");
    expect(deployRollout).toBeDefined();
    expect(retiredCleanup).toBeDefined();
    expect(deployRollout).toContain("npm run verify:rollout");
    expect(deployRollout).toContain("npm run deploy:retired-products:cleanup");
    expect(deployRollout).toContain("npm run deploy:rollout:staged");
    expect(deployRollout!.indexOf("deploy:retired-products:cleanup")).toBeLessThan(deployRollout!.indexOf("deploy:rollout:staged"));
    expect(retiredCleanup).toContain("db:retire-products:remote");
    expect(retiredCleanup).toContain("verify:migration:remote");
    expect(pkg.scripts["deploy:rollout:staged"]).toBe("npm run deploy:phase1:schema && npm run deploy:worker && npm run deploy:phase2:schema");
    expect(pkg.scripts["verify:rollout"]).toContain("npm run db:retire-products");
    expect(pkg.scripts["deploy:phase1:schema"]).toContain("--config wrangler.phase1.jsonc");
    expect(pkg.scripts["deploy:phase1:schema"]).toContain("verify:migration:remote:phase1");
    expect(pkg.scripts["deploy:phase2:schema"]).toContain("wrangler d1 migrations apply ventora-crm --remote");
    expect(pkg.scripts["deploy:phase2:schema"]).toContain("verify-deployed-worker");
    expect(pkg.scripts["db:migrate:remote"]).toContain("Remote schema changes are staged");
    expect(pkg.scripts["db:migrate:remote"]).toContain("npm run deploy:rollout");
  });
});

describe("reviews admin UI", () => {
  it("renders API error messages and invalidates old customer caches when relinking reviews", () => {
    const source = readFileSync("admin/src/pages/Reviews.tsx", "utf8");

    expect(source).toContain("getErrorMessage");
    expect(source).toContain("previousCustomerId");
    expect(source).toContain('queryClient.invalidateQueries({ queryKey: ["customer", variables.previousCustomerId] })');
  });
});

describe("settings admin router", () => {
  it("regenerates widget keys in the verified high-entropy format", () => {
    const source = readFileSync("src/routes/admin/settings.ts", "utf8");

    expect(source).toContain("crypto.getRandomValues");
    expect(source).toContain("`wk_${");
    expect(source).not.toContain("const newKey = crypto.randomUUID()");
  });
});
