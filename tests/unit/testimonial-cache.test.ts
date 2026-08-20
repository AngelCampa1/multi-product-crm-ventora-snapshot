import { describe, expect, it } from "vitest";
import { shouldBustCustomerAttributionCache } from "../../src/routes/admin/customers";
import { shouldBustTestimonialWidgetCache } from "../../src/routes/admin/testimonials";
import { reviewImportErrorMessage } from "../../src/routes/admin/reviews";

const approvedTestimonial = {
  id: "t1",
  customer_id: "c1",
  product_id: "p1",
  quote: "Original quote",
  source: "manual" as const,
  source_url: null,
  rating: 5,
  approved: 1,
  featured: 0,
  created_at: "2026-05-19T00:00:00.000Z",
};

describe("testimonial widget cache busting", () => {
  it("busts when rendered content changes on an already approved testimonial", () => {
    expect(shouldBustTestimonialWidgetCache(approvedTestimonial, { quote: "Updated quote" })).toBe(true);
    expect(shouldBustTestimonialWidgetCache(approvedTestimonial, { rating: 4 })).toBe(true);
    expect(shouldBustTestimonialWidgetCache(approvedTestimonial, { source_url: "https://example.com" })).toBe(true);
  });

  it("does not bust for rendered content edits while testimonial remains unapproved", () => {
    expect(
      shouldBustTestimonialWidgetCache(
        { ...approvedTestimonial, approved: 0 },
        { quote: "Still private" },
      ),
    ).toBe(false);
  });
});

describe("customer attribution widget cache busting", () => {
  const customer = {
    id: "c1",
    name: "Old Name",
    email: null,
    photo_r2_key: null,
    company: "Old Co",
    role: "Owner",
    twitter: null,
    linkedin: null,
    website: null,
    lifecycle: "champion" as const,
    notes: null,
    created_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-19T00:00:00.000Z",
  };

  it("busts when rendered customer attribution fields change", () => {
    expect(shouldBustCustomerAttributionCache(customer, { name: "New Name" })).toBe(true);
    expect(shouldBustCustomerAttributionCache(customer, { role: "CFO" })).toBe(true);
    expect(shouldBustCustomerAttributionCache(customer, { company: "New Co" })).toBe(true);
  });

  it("does not bust for non-rendered customer edits", () => {
    expect(shouldBustCustomerAttributionCache(customer, { notes: "Private note" })).toBe(false);
    expect(shouldBustCustomerAttributionCache(customer, { name: "Old Name" })).toBe(false);
  });
});

describe("review import errors", () => {
  it("formats scraper failures for JSON admin responses", () => {
    expect(reviewImportErrorMessage(new Error("scrape-g2: HTTP 403"))).toBe("scrape-g2: HTTP 403");
    expect(reviewImportErrorMessage("network unavailable")).toBe("network unavailable");
  });
});
