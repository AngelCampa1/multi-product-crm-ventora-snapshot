import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("security migration", () => {
  const migration = readFileSync("migrations/0003_security_firewall_and_widget_keys.sql", "utf8");
  const followupMigration = readFileSync("migrations/0004_complete_firewall_update_triggers.sql", "utf8");
  const productUpdateMigration = readFileSync("migrations/0005_complete_firewall_product_update_guards.sql", "utf8");
  const productScopedReviewsMigration = readFileSync(
    "migrations/0006_product_scoped_reviews_and_customer_product_update_guards.sql",
    "utf8",
  );
  const mediaAssetsMigration = readFileSync("migrations/0007_media_assets_registry.sql", "utf8");
  const customerProductSourceMigration = readFileSync("migrations/0008_customer_product_link_source.sql", "utf8");
  const mediaHardDeleteMigration = readFileSync("migrations/0009_media_registry_delete_guard.sql", "utf8");
  const phase1ReviewIndexMigration = readFileSync("migrations_phase1/0005_review_product_unique_compat_index.sql", "utf8");
  const phase1ReviewBacklogMigration = readFileSync("migrations_phase1/0006_review_import_backlog.sql", "utf8");
  const phase1MediaMigration = readFileSync("migrations_phase1/0007_media_assets_registry.sql", "utf8");
  const phase1SourceMigration = readFileSync("migrations_phase1/0008_customer_product_link_source.sql", "utf8");

  it("rotates legacy deterministic widget keys", () => {
    expect(migration).toContain("widget_public_key GLOB 'wk_*_*'");
    expect(migration).toContain("lower(hex(randomblob(16)))");
  });

  it("adds firewall triggers for every customer/product association table", () => {
    expect(migration).toContain("trg_customer_products_firewall_insert");
    expect(migration).toContain("trg_testimonials_firewall_insert");
    expect(migration).toContain("trg_testimonials_firewall_customer_update");
    expect(migration).toContain("trg_reviews_firewall_insert");
    expect(migration).toContain("trg_reviews_firewall_customer_update");
    expect(migration).toContain("trg_feedback_items_firewall_insert");
    expect(migration).toContain("trg_feedback_items_firewall_customer_update");
    expect(migration).toContain("SELECT RAISE(ABORT, 'FIREWALL_VIOLATION')");
  });

  it("adds a follow-up migration for databases that already applied the first trigger set", () => {
    expect(followupMigration).toContain("trg_testimonials_firewall_customer_update");
    expect(followupMigration).toContain("trg_reviews_firewall_insert");
    expect(followupMigration).toContain("CREATE TRIGGER IF NOT EXISTS");
  });

  it("guards product reassignment and product firewall group changes", () => {
    expect(productUpdateMigration).toContain("trg_testimonials_firewall_product_update");
    expect(productUpdateMigration).toContain("trg_reviews_firewall_product_update");
    expect(productUpdateMigration).toContain("trg_feedback_items_firewall_product_update");
    expect(productUpdateMigration).toContain("trg_products_firewall_group_update");
    expect(productUpdateMigration).toContain("BEFORE UPDATE OF product_id");
    expect(productUpdateMigration).toContain("BEFORE UPDATE OF firewall_group ON products");
    expect(productUpdateMigration).toContain("SELECT RAISE(ABORT, 'FIREWALL_VIOLATION')");
  });

  it("scopes review deduplication to products and guards customer_products updates", () => {
    expect(productScopedReviewsMigration).toContain("UNIQUE (product_id, source, external_id)");
    expect(productScopedReviewsMigration).toContain("DROP TABLE reviews");
    expect(productScopedReviewsMigration).toContain("trg_customer_products_firewall_customer_update");
    expect(productScopedReviewsMigration).toContain("trg_customer_products_firewall_product_update");
    expect(productScopedReviewsMigration).toContain("trg_reviews_firewall_insert");
    expect(productScopedReviewsMigration).toContain("trg_reviews_firewall_product_update");
    expect(productScopedReviewsMigration).toContain("SELECT RAISE(ABORT, 'FIREWALL_VIOLATION')");
  });

  it("adds a D1 media registry for coordinating customer photo references", () => {
    expect(mediaAssetsMigration).toContain("CREATE TABLE IF NOT EXISTS media_assets");
    expect(mediaAssetsMigration).toContain("key          TEXT PRIMARY KEY");
    expect(mediaAssetsMigration).toContain("deleted_at");
    expect(mediaAssetsMigration).toContain("INSERT OR IGNORE INTO media_assets");
    expect(mediaAssetsMigration).toContain("FROM customers");
    expect(mediaAssetsMigration).toContain("trg_customers_media_insert");
    expect(mediaAssetsMigration).toContain("trg_customers_media_photo_update");
    expect(mediaAssetsMigration).toContain("trg_media_assets_delete_referenced");
    expect(mediaAssetsMigration).toContain("MEDIA_ASSET_NOT_FOUND");
    expect(mediaAssetsMigration).toContain("MEDIA_IN_USE");
  });

  it("tracks customer product link provenance for content cleanup", () => {
    expect(customerProductSourceMigration).toContain("ALTER TABLE customer_products");
    expect(customerProductSourceMigration).toContain("ADD COLUMN source");
    expect(customerProductSourceMigration).toContain("CHECK (source IN ('manual', 'content'))");
  });

  it("guards hard deletes of referenced media registry rows", () => {
    expect(mediaHardDeleteMigration).toContain("trg_customers_media_insert");
    expect(mediaHardDeleteMigration).toContain("trg_customers_media_photo_update");
    expect(mediaHardDeleteMigration).toContain("trg_media_assets_delete_referenced");
    expect(mediaHardDeleteMigration).toContain("trg_media_assets_delete_referenced_row");
    expect(mediaHardDeleteMigration).toContain("BEFORE DELETE ON media_assets");
    expect(mediaHardDeleteMigration).toContain("MEDIA_IN_USE");
  });

  it("defines an old-worker-compatible phase-1 schema", () => {
    const phase1Verifier = readFileSync("scripts/verify-migration-phase1.ts", "utf8");
    const phase1Config = readFileSync("wrangler.phase1.jsonc", "utf8");

    expect(phase1ReviewIndexMigration).toContain("idx_reviews_product_source_external_unique");
    expect(phase1ReviewBacklogMigration).toContain("CREATE TABLE IF NOT EXISTS review_import_backlog");
    expect(productScopedReviewsMigration).toContain("INSERT INTO reviews_new");
    expect(productScopedReviewsMigration).not.toContain("INSERT OR IGNORE INTO reviews_new");
    expect(productScopedReviewsMigration).toContain("FROM review_import_backlog");
    expect(productScopedReviewsMigration).toContain("DROP TABLE IF EXISTS review_import_backlog");
    expect(phase1MediaMigration).toContain("CREATE TABLE IF NOT EXISTS media_assets");
    expect(phase1MediaMigration).not.toContain("CREATE TRIGGER");
    expect(phase1SourceMigration).toContain("ADD COLUMN source");
    expect(phase1Config).toContain("\"migrations_dir\": \"migrations_phase1\"");
    expect(phase1Verifier).toContain("phase 1 missing legacy reviews source/external_id unique key");
    expect(phase1Verifier).toContain("phase 1 has final media enforcement triggers installed early");
    expect(phase1Verifier).toContain("schema is already finalized");
  });

  it("verifies existing data has no same-group cross-product firewall violations", () => {
    const verifier = readFileSync("scripts/verify-migration-state.ts", "utf8");

    expect(verifier).toContain("HAVING COUNT(DISTINCT a.product_id) > 1");
    expect(verifier).toContain("found ${firewallViolationCount} existing firewall group violation(s)");
    expect(verifier).toContain("expected 13");
    expect(verifier).toContain("media_assets table is missing");
    expect(verifier).toContain("customer_products.source column is missing");
    expect(verifier).toContain("expected 4");
    expect(verifier).toContain("customers reference missing/deleted media asset rows");
    expect(verifier).toContain("reviews product-scoped unique index is missing");
    expect(verifier).toContain("reviews still has legacy global source/external_id uniqueness");
  });

  it("preflights production data before remote schema mutation and verifies schema before deploy", () => {
    const preflight = readFileSync("scripts/verify-migration-preflight.ts", "utf8");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const deployRollout = pkg.scripts["deploy:rollout"] ?? "";

    expect(preflight).toContain("photo_r2_key NOT LIKE 'media/%'");
    expect(preflight).toContain("classify provenance before 0008");
    expect(preflight).toContain("HAVING COUNT(DISTINCT a.product_id) > 1");
    expect(pkg.scripts.deploy).toBe("npm run deploy:rollout");
    expect(deployRollout).toContain("npm run verify:rollout");
    expect(deployRollout).toContain("npm run deploy:retired-products:cleanup");
    expect(deployRollout).toContain("npm run deploy:rollout:staged");
    expect(deployRollout.indexOf("deploy:retired-products:cleanup")).toBeLessThan(deployRollout.indexOf("deploy:rollout:staged"));
    expect(pkg.scripts["db:migrate:remote"]).toContain("Remote schema changes are staged");
    expect(pkg.scripts["deploy:phase1:schema"]).toBeDefined();
    expect(pkg.scripts["deploy:phase2:schema"]).toContain("verify-deployed-worker");
    expect(pkg.scripts["deploy:phase1:schema"]).toContain("verify:migration:remote:preflight");
  });

  it("smokes deployed public surfaces before phase 2 remote migration", () => {
    const verifier = readFileSync("scripts/verify-deployed-worker.ts", "utf8");

    expect(verifier).toContain("EXPECTED_SCHEMA_COMPAT");
    expect(verifier).toContain("/admin");
    expect(verifier).toContain("/w/v1.js");
    expect(verifier).toContain("widgets.ventoralabs.com");
    expect(verifier).toContain("widget_public_key");
    expect(verifier).toContain("origin required");
    expect(verifier).toContain("data-api-base");
  });

  it("uses a unique fixture prefix for each firewall trigger verifier run", () => {
    const verifier = readFileSync("scripts/verify-firewall-triggers.ts", "utf8");

    expect(verifier).toContain("const PREFIX = `verify_fw_${Date.now()}_${Math.random().toString(16).slice(2)}_`");
    expect(verifier).toContain("DELETE FROM products WHERE id LIKE '${PREFIX}%'");
    expect(verifier).toContain("testimonial_conflict");
    expect(verifier).toContain("review_conflict");
    expect(verifier).toContain("feedback_conflict");
    expect(verifier).toContain("UPDATE testimonials SET customer_id");
    expect(verifier).toContain("UPDATE reviews SET customer_id");
    expect(verifier).toContain("UPDATE feedback_items SET customer_id");
  });

  it("exercises media trigger behavior against D1", () => {
    const verifier = readFileSync("scripts/verify-media-triggers.ts", "utf8");
    const pkg = readFileSync("package.json", "utf8");

    expect(verifier).toContain("const PREFIX = `verify_media_${Date.now()}_${Math.random().toString(16).slice(2)}_`");
    expect(verifier).toContain("MEDIA_ASSET_NOT_FOUND");
    expect(verifier).toContain("MEDIA_IN_USE");
    expect(verifier).toContain("DELETE FROM media_assets");
    expect(pkg).toContain("\"verify:media\"");
    expect(pkg).toContain("npm run verify:media");
  });
});
