import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../../src/worker";

function envWithDbThatMustNotBeUsed(): Env {
  return {
    DEV_AUTH_BYPASS: "true",
    DB: {
      prepare: vi.fn(() => {
        throw new Error("DB should not be used for invalid payloads");
      }),
      batch: vi.fn(),
      dump: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database,
    MEDIA: {
      delete: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      head: vi.fn(),
      list: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    } as unknown as R2Bucket,
    ASSETS: {
      fetch: vi.fn(async () => new Response("not found", { status: 404 })),
    } as unknown as Fetcher,
  };
}

function envWithMissingProductLookup(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM products WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        };
      }
      if (sql.includes("INSERT INTO customers")) {
        throw new Error("customer insert should not run before product validation");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envWithExistingCustomerAndMissingProduct(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM customers WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: "customer-1",
            name: "Customer 1",
            email: null,
            photo_r2_key: null,
            company: null,
            role: null,
            twitter: null,
            linkedin: null,
            website: null,
            lifecycle: "lead",
            notes: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
        };
      }
      if (sql.includes("SELECT * FROM products WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        };
      }
      if (sql.includes("INSERT INTO customer_products")) {
        throw new Error("link insert should not run before product validation");
      }
      if (sql.includes("UPDATE customers") && sql.includes("media_assets")) {
        return {
          bind: vi.fn().mockReturnThis(),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envWithExistingTestimonialNoUpdate(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM testimonials WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: "testimonial-1",
            customer_id: "customer-1",
            product_id: "product-1",
            quote: "Existing real quote",
            source: "manual",
            source_url: null,
            rating: null,
            approved: 0,
            featured: 0,
            created_at: "2026-01-01T00:00:00.000Z",
          }),
        };
      }
      if (sql.includes("UPDATE testimonials")) {
        throw new Error("testimonial update should not run for invalid payloads");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envWithValidProductCustomerNoContentInsert(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM products WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: "product-1",
            slug: "product-1",
            name: "Product 1",
            brand_color: null,
            primary_domain: null,
            widget_public_key: "wk_product1",
            origin_allowlist_json: "[]",
            firewall_group: null,
            created_at: "2026-01-01T00:00:00.000Z",
          }),
        };
      }
      if (sql.includes("SELECT * FROM customers WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: "customer-1",
            name: "Customer 1",
            email: null,
            photo_r2_key: null,
            company: null,
            role: null,
            twitter: null,
            linkedin: null,
            website: null,
            lifecycle: "lead",
            notes: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
        };
      }
      if (sql.includes("INSERT INTO customer_products")) {
        throw new Error("product link should not run for invalid testimonial payloads");
      }
      if (sql.includes("INSERT INTO testimonials")) {
        throw new Error("testimonial insert should not run for invalid payloads");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envForAllowedIngest(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM products WHERE widget_public_key = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: "grantpipe",
            slug: "grantpipe",
            name: "GrantPipe",
            brand_color: null,
            primary_domain: "grantpipe.com",
            widget_public_key: "wk_grantpipe",
            origin_allowlist_json: "[\"https://app.grantpipe.com\"]",
            firewall_group: null,
            created_at: "2026-01-01T00:00:00.000Z",
          }),
        };
      }
      if (sql.includes("INSERT INTO ingest_rate_limit")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ count: 1 }),
        };
      }
      if (sql.includes("INSERT INTO feedback_items")) {
        throw new Error("feedback insert should not run for invalid payloads");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envWithFeedbackProductLookupMustNotRun(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM products WHERE id = ?")) {
        throw new Error("product lookup should not run for invalid feedback payloads");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envWithExistingFeedbackNoUpdate(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM feedback_items WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: "feedback-1",
            customer_id: null,
            product_id: "product-1",
            type: "bug",
            title: "Existing",
            body: null,
            status: "new",
            upvotes: 0,
            public_visible: 0,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
        };
      }
      if (sql.includes("UPDATE feedback_items")) {
        throw new Error("feedback update should not run for invalid public_visible");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envWithLinkedProductContent(): Env {
  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT COUNT(*) as total FROM (")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ total: 1 }),
        };
      }
      if (sql.includes("DELETE FROM customer_products")) {
        throw new Error("product unlink should not run while linked content exists");
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    ...envWithDbThatMustNotBeUsed(),
    DB: db,
  };
}

function envWithLinkFailureAfterCustomerCreate() {
  const deletedCustomerIds: string[] = [];
  let customerId = "";

  const db = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes("SELECT * FROM products WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: "product-1",
            slug: "product-1",
            name: "Product 1",
            brand_color: null,
            primary_domain: null,
            widget_public_key: "wk_product1",
            origin_allowlist_json: "[]",
            firewall_group: null,
            created_at: "2026-01-01T00:00:00.000Z",
          }),
        };
      }
      if (sql.includes("INSERT INTO customers")) {
        return {
          bind: vi.fn((id: string) => {
            customerId = id;
            return { run: vi.fn().mockResolvedValue({ success: true }) };
          }),
        };
      }
      if (sql.includes("INSERT INTO customer_products")) {
        return {
          bind: vi.fn().mockReturnThis(),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
        };
      }
      if (sql.includes("SELECT 1 FROM customer_products")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        };
      }
      if (sql.includes("SELECT p.* FROM products p")) {
        return {
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: [] }),
        };
      }
      if (sql.includes("SELECT firewall_group FROM products WHERE id = ?")) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ firewall_group: null }),
        };
      }
      if (sql.includes("DELETE FROM customers WHERE id = ?")) {
        return {
          bind: vi.fn((id: string) => {
            deletedCustomerIds.push(id);
            return { run: vi.fn().mockResolvedValue({ success: true }) };
          }),
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return {
    env: {
      ...envWithDbThatMustNotBeUsed(),
      DB: db,
    },
    deletedCustomerIds,
    getCustomerId: () => customerId,
  };
}

function adminPost(path: string, body: unknown) {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ventora-CSRF": "1",
    },
    body: JSON.stringify(body),
  });
}

function adminPatch(path: string, body: unknown) {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Ventora-CSRF": "1",
    },
    body: JSON.stringify(body),
  });
}

function adminPostRaw(path: string, body: string) {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ventora-CSRF": "1",
    },
    body,
  });
}

function publicPost(path: string, body: unknown, origin = "https://app.grantpipe.com") {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": origin,
    },
    body: JSON.stringify(body),
  });
}

function publicPostRaw(path: string, body: string, headers: Record<string, string>) {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: {
      "Origin": "https://app.grantpipe.com",
      ...headers,
    },
    body,
  });
}

function publicPostStream(path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string>) {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: {
      "Origin": "https://app.grantpipe.com",
      ...headers,
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function adminDelete(path: string) {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "DELETE",
    headers: {
      "X-Ventora-CSRF": "1",
    },
  });
}

describe("admin backend validation", () => {
  it("configures Static Assets to run the Worker first for bare reserved prefixes", () => {
    const config = readFileSync("wrangler.jsonc", "utf8");

    expect(config).toContain('"/*"');
    expect(config).not.toContain('"run_worker_first": []');
  });

  it.each([
    "/api",
    "/api/not-real",
    "/api/admin/not-real",
    "/media",
    "/preview",
    "/w",
    "/w/not-real",
  ])("returns backend 404 JSON for reserved path %s instead of SPA fallback", async (path) => {
    const env = envWithDbThatMustNotBeUsed();
    const response = await worker.fetch(
      new Request(`http://127.0.0.1:8787${path}`),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed customer JSON before D1 work", async () => {
    const response = await worker.fetch(
      adminPostRaw("/api/admin/customers", "{"),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid JSON body",
    });
  });

  it("rejects non-object customer JSON before D1 work", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/customers", []),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "customer body must be a JSON object",
    });
  });

  it("rejects invalid customer lifecycle values before D1 constraints", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/customers", { name: "Bad Lifecycle", lifecycle: "bad" }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "lifecycle must be one of: lead, active, churned, champion",
    });
  });

  it("rejects invalid customer lifecycle filters before D1 work", async () => {
    const response = await worker.fetch(
      new Request("http://127.0.0.1:8787/api/admin/customers?lifecycle=bad"),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "lifecycle must be one of: lead, active, churned, champion",
    });
  });

  it("rejects testimonial creation without required ids before D1 lookups", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/testimonials", { quote: "A real quote", source: "manual" }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "customer_id and product_id are required",
    });
  });

  it("rejects missing customer product links before inserting the customer", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/customers", {
        name: "Missing Product",
        product_ids: ["missing-product"],
      }),
      envWithMissingProductLookup(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "product not found",
      product_id: "missing-product",
    });
  });

  it("rejects malformed customer product_ids before D1 work", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/customers", {
        name: "Malformed Products",
        product_ids: {},
      }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "product_ids must be an array of product id strings",
    });
  });

  it("rejects missing link-product products before D1 link inserts", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/customers/customer-1/link-product", { product_id: "missing-product" }),
      envWithExistingCustomerAndMissingProduct(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "product not found",
      product_id: "missing-product",
    });
  });

  it("rejects invalid customer lifecycle patches before D1 lookups", async () => {
    const response = await worker.fetch(
      adminPatch("/api/admin/customers/customer-1", { lifecycle: "bad" }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "lifecycle must be one of: lead, active, churned, champion",
    });
  });

  it("rejects non-string testimonial quotes before D1 lookups", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/testimonials", {
        customer_id: "customer-1",
        product_id: "product-1",
        quote: 123,
        source: "manual",
      }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "quote is required",
    });
  });

  it.each([
    ["approved", "false"],
    ["approved", 1],
    ["approved", null],
    ["featured", "false"],
    ["featured", 1],
    ["featured", null],
  ])("rejects non-boolean testimonial patch field %s=%s before D1 updates", async (field, value) => {
    const response = await worker.fetch(
      adminPatch("/api/admin/testimonials/testimonial-1", { [field]: value }),
      envWithExistingTestimonialNoUpdate(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: `${field} must be a boolean`,
    });
  });

  it("rejects invalid testimonial patch source_url before D1 updates", async () => {
    const response = await worker.fetch(
      adminPatch("/api/admin/testimonials/testimonial-1", { source_url: 123 }),
      envWithExistingTestimonialNoUpdate(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "source_url must be a string or null",
    });
  });

  it("rejects non-boolean testimonial create approved before D1 work", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/testimonials", {
        customer_id: "customer-1",
        product_id: "product-1",
        quote: "A real quote",
        source: "manual",
        approved: "false",
      }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "approved must be a boolean",
    });
  });

  it.each([
    [{ rating: 6 }, "rating must be between 1 and 5"],
    [{ source_url: 123 }, "source_url must be a string or null"],
  ])("rejects invalid testimonial scalar fields before product linking", async (patch, error) => {
    const response = await worker.fetch(
      adminPost("/api/admin/testimonials", {
        customer_id: "customer-1",
        product_id: "product-1",
        quote: "A real quote",
        source: "manual",
        ...patch,
      }),
      envWithValidProductCustomerNoContentInsert(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it.each([
    "/api/admin/testimonials?approved=maybe",
    "/api/admin/testimonials?featured=maybe",
    "/api/admin/feedback?type=bad",
    "/api/admin/feedback?status=bad",
  ])("rejects invalid list filter %s before D1 work", async (path) => {
    const response = await worker.fetch(
      new Request(`http://127.0.0.1:8787${path}`),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
  });

  it("rejects non-object testimonial patches before D1 work", async () => {
    const response = await worker.fetch(
      adminPatch("/api/admin/testimonials/testimonial-1", []),
      envWithExistingTestimonialNoUpdate(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "testimonial body must be a JSON object",
    });
  });

  it.each([
    [{ name: null }, "name must be a non-empty string"],
    [{ name: "" }, "name must be a non-empty string"],
    [{ email: {} }, "email must be a string or null"],
    [{ photo_r2_key: 123 }, "photo_r2_key must be a string or null"],
  ])("rejects invalid customer patch payloads before D1 lookups", async (patch, error) => {
    const response = await worker.fetch(
      adminPatch("/api/admin/customers/customer-1", patch),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it("rejects unmanaged customer photo keys before updating customers", async () => {
    const response = await worker.fetch(
      adminPatch("/api/admin/customers/customer-1", { photo_r2_key: "private/object.png" }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "photo_r2_key must reference a managed media key",
    });
  });

  it("rejects missing managed customer photo keys before updating customers", async () => {
    const env = envWithExistingCustomerAndMissingProduct();

    const response = await worker.fetch(
      adminPatch("/api/admin/customers/customer-1", { photo_r2_key: "media/missing.png" }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "photo_r2_key not found",
    });
  });

  it("rejects non-object public ingest JSON before feedback inserts", async () => {
    const response = await worker.fetch(
      publicPost("/w/ingest/wk_grantpipe", null),
      envForAllowedIngest(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "feedback body must be a JSON object",
    });
  });

  it("rejects invalid admin feedback public_visible before product lookup", async () => {
    const response = await worker.fetch(
      adminPost("/api/admin/feedback", {
        product_id: "product-1",
        type: "bug",
        title: "Valid",
        public_visible: "true",
      }),
      envWithFeedbackProductLookupMustNotRun(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "public_visible must be a boolean or 0/1",
    });
  });

  it("rejects invalid admin feedback patch public_visible before updating", async () => {
    const response = await worker.fetch(
      adminPatch("/api/admin/feedback/feedback-1", {
        public_visible: "false",
      }),
      envWithExistingFeedbackNoUpdate(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "public_visible must be a boolean or 0/1",
    });
  });

  it("rejects oversized public ingest requests before D1 work", async () => {
    const response = await worker.fetch(
      publicPostRaw("/w/ingest/wk_grantpipe", "{}", {
        "Content-Type": "application/json",
        "Content-Length": String(32 * 1024 + 1),
      }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "feedback payload exceeds 32KB limit",
    });
  });

  it("rejects oversized public ingest requests without trusting Content-Length", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(8192));
        if (pulls >= 10) {
          controller.close();
        }
      },
    });

    const response = await worker.fetch(
      publicPostStream("/w/ingest/wk_grantpipe", stream, {
        "Content-Type": "application/json",
      }),
      envForAllowedIngest(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "feedback payload exceeds 32KB limit",
    });
    expect(pulls).toBeLessThan(10);
  });

  it.each([
    "/",
    "/admin",
    "/api/admin/me",
    "/preview/camaudit-v2/wall-grid",
  ])("blocks %s on the public widget host before assets auth or DB", async (path) => {
    const response = await worker.fetch(
      new Request(`https://widgets.ventoralabs.com${path}`, {
        headers: { Host: "widgets.ventoralabs.com" },
      }),
      {
        ...envWithDbThatMustNotBeUsed(),
        ASSETS: {
          fetch: vi.fn(() => {
            throw new Error("widgets host should not fall through to admin assets");
          }),
        } as unknown as Fetcher,
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });

  it("still serves the widget loader on the public widget host", async () => {
    const response = await worker.fetch(
      new Request("https://widgets.ventoralabs.com/w/v1.js", {
        headers: { Host: "widgets.ventoralabs.com" },
      }),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
  });

  it("does not serve public media unless the registry row is live", async () => {
    const mediaGet = vi.fn();
    const db = {
      prepare: vi.fn((sql: string) => {
        expect(sql).toContain("FROM media_assets");
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
        };
      }),
      batch: vi.fn(),
      dump: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const response = await worker.fetch(
      new Request("https://crm.ventoralabs.com/media/customer-photo.png"),
      {
        ...envWithDbThatMustNotBeUsed(),
        DB: db,
        MEDIA: {
          ...envWithDbThatMustNotBeUsed().MEDIA,
          get: mediaGet,
        } as unknown as R2Bucket,
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
    expect(mediaGet).not.toHaveBeenCalled();
  });

  it("restores media registry rows when best-effort R2 cleanup fails", () => {
    const source = readFileSync("src/routes/admin/customers.ts", "utf8");

    expect(source).toContain("async function deleteManagedMediaIfUnreferenced");
    expect(source).toContain("await restoreMediaAsset(env.DB, key)");
    expect(source).toContain("Managed media R2 cleanup failed");
    expect(source).not.toContain("orphan a key rather than fail the patch");
  });

  it.each([
    [{ type: "bug", title: "x".repeat(161) }, "title must be 160 characters or fewer"],
    [{ type: "bug", title: "Valid", body: "x".repeat(5001) }, "body must be 5000 characters or fewer"],
    [{ type: "bug", title: "Valid", customer_email: `${"x".repeat(245)}@example.com` }, "customer_email must be 254 characters or fewer"],
  ])("rejects oversized public ingest fields before feedback inserts", async (body, error) => {
    const response = await worker.fetch(
      publicPost("/w/ingest/wk_grantpipe", body),
      envForAllowedIngest(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
  });

  it("rejects unknown preview widgets before product lookups", async () => {
    const response = await worker.fetch(
      new Request("http://127.0.0.1:8787/preview/grantpipe/not-a-widget"),
      envWithDbThatMustNotBeUsed(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unknown widget type: not-a-widget",
    });
  });

  it("rejects unlinking a customer from a product while product content remains", async () => {
    const response = await worker.fetch(
      adminDelete("/api/admin/customers/customer-1/products/product-1"),
      envWithLinkedProductContent(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "customer has linked content for this product; delete or reassign it before unlinking",
      code: "PRODUCT_CONTENT_EXISTS",
    });
  });

  it("deletes the newly created customer when product linking fails after insert", async () => {
    const setup = envWithLinkFailureAfterCustomerCreate();
    const response = await worker.fetch(
      adminPost("/api/admin/customers", {
        name: "Cleanup Required",
        product_ids: ["product-1"],
      }),
      setup.env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(setup.getCustomerId()).toBeTruthy();
    expect(setup.deletedCustomerIds).toEqual([setup.getCustomerId()]);
  });
});

describe("ingest rate-limit header hardening", () => {
  function envCapturingRateLimitIdentity() {
    const capturedIdentities: string[] = [];

    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("SELECT * FROM products WHERE widget_public_key = ?")) {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue({
              id: "grantpipe",
              slug: "grantpipe",
              name: "GrantPipe",
              brand_color: null,
              primary_domain: "grantpipe.com",
              widget_public_key: "wk_grantpipe",
              origin_allowlist_json: "[\"https://app.grantpipe.com\"]",
              firewall_group: null,
              created_at: "2026-01-01T00:00:00.000Z",
            }),
          };
        }
        if (sql.includes("INSERT INTO ingest_rate_limit")) {
          return {
            bind: vi.fn((_productId: string, identity: string, _windowStart: string) => {
              capturedIdentities.push(identity);
              return {
                first: vi.fn().mockResolvedValue({ count: 1 }),
              };
            }),
          };
        }
        if (sql.includes("INSERT INTO feedback_items")) {
          throw new Error("feedback insert should not run for invalid payloads");
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
      batch: vi.fn(),
      dump: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const env: Env = {
      DEV_AUTH_BYPASS: "true",
      DB: db,
      MEDIA: {
        delete: vi.fn(),
        get: vi.fn(),
        put: vi.fn(),
        head: vi.fn(),
        list: vi.fn(),
        createMultipartUpload: vi.fn(),
        resumeMultipartUpload: vi.fn(),
      } as unknown as R2Bucket,
      ASSETS: {
        fetch: vi.fn(async () => new Response("not found", { status: 404 })),
      } as unknown as Fetcher,
    };

    return { env, capturedIdentities };
  }

  it("ignores X-Forwarded-For when CF-Connecting-IP is absent — both requests share the same rate-limit bucket", async () => {
    const { env, capturedIdentities } = envCapturingRateLimitIdentity();

    const req1 = new Request("http://127.0.0.1:8787/w/ingest/wk_grantpipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://app.grantpipe.com",
        "X-Forwarded-For": "1.1.1.1",
      },
      body: JSON.stringify(null),
    });

    const req2 = new Request("http://127.0.0.1:8787/w/ingest/wk_grantpipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://app.grantpipe.com",
        "X-Forwarded-For": "9.9.9.9",
      },
      body: JSON.stringify(null),
    });

    await worker.fetch(req1, env, {} as ExecutionContext);
    await worker.fetch(req2, env, {} as ExecutionContext);

    expect(capturedIdentities).toHaveLength(2);
    // Both must be identical — XFF must NOT differentiate them
    expect(capturedIdentities[0]).toBe(capturedIdentities[1]);
    // And the identity must use the unknown sentinel (no CF-Connecting-IP was present)
    expect(capturedIdentities[0]).toBe("https://app.grantpipe.com|unknown");
  });

  it("uses distinct rate-limit identities for requests with different CF-Connecting-IP values", async () => {
    const { env, capturedIdentities } = envCapturingRateLimitIdentity();

    const req1 = new Request("http://127.0.0.1:8787/w/ingest/wk_grantpipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://app.grantpipe.com",
        "CF-Connecting-IP": "1.2.3.4",
      },
      body: JSON.stringify(null),
    });

    const req2 = new Request("http://127.0.0.1:8787/w/ingest/wk_grantpipe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://app.grantpipe.com",
        "CF-Connecting-IP": "5.6.7.8",
      },
      body: JSON.stringify(null),
    });

    await worker.fetch(req1, env, {} as ExecutionContext);
    await worker.fetch(req2, env, {} as ExecutionContext);

    expect(capturedIdentities).toHaveLength(2);
    expect(capturedIdentities[0]).toBe("https://app.grantpipe.com|1.2.3.4");
    expect(capturedIdentities[1]).toBe("https://app.grantpipe.com|5.6.7.8");
    expect(capturedIdentities[0]).not.toBe(capturedIdentities[1]);
  });
});
