import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("admin reviews route", () => {
  it("enforces the product firewall before linking reviews to customers", () => {
    const source = readFileSync("src/routes/admin/reviews.ts", "utf8");

    expect(source).toContain("assertFirewallSafe");
    expect(source).toContain("linkCustomerToProduct");
    expect(source).toContain("FIREWALL_VIOLATION");
    expect(source.indexOf("assertFirewallSafe")).toBeLessThan(source.indexOf("UPDATE reviews SET customer_id"));
  });
});

describe("admin customer merge route", () => {
  it("checks source testimonial and review product associations before merging", () => {
    const source = readFileSync("src/routes/admin/customers.ts", "utf8");

    expect(source).toContain("sourceProductIds");
    expect(source).toContain("FROM testimonials WHERE customer_id = ?");
    expect(source).toContain("FROM reviews WHERE customer_id = ?");
    expect(source.indexOf("sourceProductIds")).toBeLessThan(source.indexOf("UPDATE testimonials SET customer_id"));
  });

  it("copies every source-associated product link inside the same merge batch before deleting the source", () => {
    const source = readFileSync("src/routes/admin/customers.ts", "utf8");

    expect(source).toContain("INSERT INTO customer_products (customer_id, product_id, joined_at, source)");
    expect(source).toContain("sourceProducts.map");
    expect(source).toContain("VALUES (?, ?, ?, ?)");
    expect(source).toContain("WHEN customer_products.source = 'manual' OR excluded.source = 'manual'");
    expect(source.indexOf("INSERT INTO customer_products")).toBeLessThan(source.indexOf("DELETE FROM customers WHERE id = ?"));
    expect(source).not.toContain("for (const product of sourceProducts)");
  });

  it("busts approved testimonial widget caches after merging customer attribution", () => {
    const source = readFileSync("src/routes/admin/customers.ts", "utf8");

    expect(source).toContain("cacheBustProducts");
    expect(source).toContain("t.approved = 1");
    expect(source).toContain("bustProductWidgets(product.slug)");
  });
});
