import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

async function getCamauditWidgetKey(request: APIRequestContext) {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();
  const products = await response.json() as Array<{ id: string; slug: string; widget_public_key: string }>;
  const product = products.find((p) => p.slug === "camaudit-v2");
  expect(product).toBeTruthy();
  return product!.widget_public_key;
}

async function getWidgetKeyBySlug(request: APIRequestContext, slug: string) {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();
  const products = await response.json() as Array<{ id: string; slug: string; widget_public_key: string }>;
  const product = products.find((p) => p.slug === slug);
  expect(product).toBeTruthy();
  return product!.widget_public_key;
}

async function getProductBySlug(request: APIRequestContext, slug: string) {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();
  const products = await response.json() as Array<{ id: string; slug: string; widget_public_key: string }>;
  const product = products.find((p) => p.slug === slug);
  expect(product).toBeTruthy();
  return product!;
}

test("serves health check", async ({ request }) => {
  const response = await request.get("/healthz");

  await expect(response).toBeOK();
  expect(response.headers()["content-type"]).toMatch(/application\/json/);
  expect(await response.json()).toEqual({
    ok: true,
    service: "ventora-crm",
    schema_compat: 2,
  });
});

test("returns backend JSON for bare reserved prefixes", async ({ request }) => {
  for (const path of ["/api", "/w", "/preview"]) {
    const response = await request.get(path);

    expect(response.status(), path).toBe(404);
    expect(response.headers()["content-type"]).toMatch(/application\/json/);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  }
});

test("partitions the public widget host in the real Worker runtime", async ({ request }) => {
  const base = `http://127.0.0.1:${process.env.E2E_PORT ?? "8787"}`;
  for (const path of ["/", "/admin", "/api/admin/me", "/preview/camaudit-v2/wall-grid"]) {
    const response = await fetch(`${base}${path}`, {
      headers: { "X-Forwarded-Host": "widgets.ventoralabs.com" },
    });
    expect(response.status, path).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  }

  const loader = await request.get("/w/v1.js", {
    headers: { Host: "widgets.ventoralabs.com" },
  });
  await expect(loader).toBeOK();
  expect(loader.headers()["content-type"]).toMatch(/application\/javascript/);
});

test("exposes the S2S ingest route on the public widget host while HMAC still gates it", async () => {
  const base = `http://127.0.0.1:${process.env.E2E_PORT ?? "8787"}`;

  // The HMAC-authed S2S intake must be reachable on the public widgets host
  // (crm.ventoralabs.com is behind Cloudflare Access, unreachable by the signing
  // Worker). The host-gate must let /s/ingest/* through so the in-route HMAC guard
  // can authenticate it — an unsigned POST reaches that guard and is rejected 401,
  // NOT swallowed as 404 by the host partition.
  const unsigned = await fetch(`${base}/s/ingest/leads/camaudit-v2`, {
    method: "POST",
    headers: {
      "X-Forwarded-Host": "widgets.ventoralabs.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ping: true }),
  });
  // 500 means the HMAC guard was reached but CRM_INGEST_SECRET is unset — a test
  // setup failure (the secret must be present in .dev.vars), not the behaviour
  // under test. Surface it distinctly so it is not mistaken for a host-gate bug.
  expect(unsigned.status, "CRM_INGEST_SECRET must be set in .dev.vars so the HMAC guard rejects with 401, not 500").not.toBe(500);
  expect(unsigned.status, "unsigned ingest POST should reach the HMAC guard (401), not the host-gate 404").toBe(401);

  // Control: non-ingest /s/* paths stay partitioned off the public host.
  for (const path of ["/s", "/s/ingest", "/s/other"]) {
    const response = await fetch(`${base}${path}`, {
      headers: { "X-Forwarded-Host": "widgets.ventoralabs.com" },
    });
    expect(response.status, path).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  }
});

test("rejects admin mutations without CSRF protection in the mounted Worker", async ({ request }) => {
  const missingHeader = await request.post("/api/admin/feedback", {
    data: { product_id: "camaudit-v2", type: "general", title: "Missing CSRF" },
  });
  expect(missingHeader.status()).toBe(403);

  const crossOrigin = await request.post("/api/admin/feedback", {
    headers: {
      "X-Ventora-CSRF": "1",
      Origin: "https://evil.example",
    },
    data: { product_id: "camaudit-v2", type: "general", title: "Bad Origin" },
  });
  expect(crossOrigin.status()).toBe(403);
});

test("serves admin dashboard summary", async ({ request }) => {
  const response = await request.get("/api/admin/dashboard");

  await expect(response).toBeOK();

  const body = await response.json();
  expect(body.customers).toEqual(
    expect.objectContaining({
      total: expect.any(Number),
      lead: expect.any(Number),
      active: expect.any(Number),
      churned: expect.any(Number),
      champion: expect.any(Number),
    }),
  );
  expect(body.testimonials).toEqual(
    expect.objectContaining({
      approved: expect.any(Number),
      pending: expect.any(Number),
    }),
  );
  expect(body.feedback.total).toEqual(expect.any(Number));
  expect(body.reviews.total).toEqual(expect.any(Number));
  expect(body.products.length).toBeGreaterThan(0);
  expect(body.products[0]).toEqual(
    expect.objectContaining({
      slug: expect.any(String),
      feedback_count: expect.any(Number),
      review_count: expect.any(Number),
    }),
  );
  expect(Array.isArray(body.pending_testimonials)).toBe(true);
});

test("renders the overview as the admin landing page without the public feedback widget", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Product readiness")).toBeVisible();
  await expect(page.getByText("Work queue")).toBeVisible();
  await expect(page.getByText("Send feedback")).toHaveCount(0);

  const widgetScriptCount = await page.locator('script[src*="widgets.ventoralabs.com/w/v1.js"]').count();
  expect(widgetScriptCount).toBe(0);
});

test("serves widget loader with script-origin data URL", async ({ request }) => {
  const response = await request.get("/w/v1.js");

  await expect(response).toBeOK();
  expect(response.headers()["content-type"]).toMatch(/application\/javascript/);

  const body = await response.text();
  expect(body).toContain("loaderUrl.origin + '/w/data'");
  expect(body).toContain("data-api-base");
  expect(body).toContain("fetch(dataBase + '/'");
  expect(body).not.toContain("fetch('/w/data/'");
});

test("serves feedback button payload with absolute CRM ingest URL", async ({ request }) => {
  const widgetKey = await getCamauditWidgetKey(request);
  const publicResponse = await request.get(`/w/data/${widgetKey}/feedback-button`, {
    headers: { Origin: "https://camaudit.io" },
  });
  expect(publicResponse.status()).toBe(403);

  const response = await request.get(`/w/data/${widgetKey}/feedback-button`, {
    headers: { Origin: "https://app.camaudit.io" },
  });

  await expect(response).toBeOK();
  expect(response.headers()["cache-control"]).toBe("no-store");

  const body = await response.json();
  expect(body.ingest_url).toMatch(/https?:\/\/[^"]+\/w\/ingest\/wk_[0-9a-f]{32}/);
  expect(body.__css).toContain("background: #0f4c81;");
  expect(body.__js).toBeUndefined();
});

test("accepts feedback submissions from authenticated product origins", async ({ request }) => {
  const widgetKey = await getCamauditWidgetKey(request);
  const payloadResponse = await request.get(`/w/data/${widgetKey}/feedback-button`, {
    headers: { Origin: "https://app.camaudit.io" },
  });
  await expect(payloadResponse).toBeOK();
  const payload = await payloadResponse.json();
  const ingestPath = new URL(payload.ingest_url).pathname;

  const publicSubmit = await request.post(ingestPath, {
    headers: { Origin: "https://camaudit.io" },
    data: {
      type: "general",
      title: "E2E public-origin rejection",
    },
  });
  expect(publicSubmit.status()).toBe(403);

  const title = `E2E feedback ingest ${Date.now()}`;
  const appSubmit = await request.post(ingestPath, {
    headers: { Origin: "https://app.camaudit.io" },
    data: {
      type: "general",
      title,
      body: "Automated end-to-end CRM feedback ingest check.",
    },
  });
  await expect(appSubmit).toBeOK();
  const body = await appSubmit.json();
  expect(body).toEqual(expect.objectContaining({ ok: true, id: expect.any(String) }));

  const cleanup = await request.delete(`/api/admin/feedback/${body.id}`, {
    headers: { "X-Ventora-CSRF": "1" },
  });
  expect([204, 404]).toContain(cleanup.status());
});

test("rate limits public feedback submissions by origin and client IP", async ({ request }) => {
  const unique = Date.now();
  const widgetKey = await getCamauditWidgetKey(request);
  const payloadResponse = await request.get(`/w/data/${widgetKey}/feedback-button`, {
    headers: { Origin: "https://app.camaudit.io" },
  });
  await expect(payloadResponse).toBeOK();
  const payload = await payloadResponse.json();
  const ingestPath = new URL(payload.ingest_url).pathname;
  const feedbackIds: string[] = [];

  try {
    for (let i = 0; i < 10; i += 1) {
      const response = await request.post(ingestPath, {
        headers: {
          Origin: "https://app.camaudit.io",
          "CF-Connecting-IP": `203.0.113.${unique % 200}`,
        },
        data: {
          type: "general",
          title: `E2E rate limited feedback ${unique}-${i}`,
        },
      });
      expect(response.status(), `request ${i + 1}`).toBe(201);
      const body = await response.json() as { id: string };
      feedbackIds.push(body.id);
    }

    const limited = await request.post(ingestPath, {
      headers: {
        Origin: "https://app.camaudit.io",
        "CF-Connecting-IP": `203.0.113.${unique % 200}`,
      },
      data: {
        type: "general",
        title: `E2E rate limited feedback ${unique}-blocked`,
      },
    });
    expect(limited.status()).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "rate limit exceeded" });
  } finally {
    for (const id of feedbackIds) {
      await request.delete(`/api/admin/feedback/${id}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
  }
});

test("rejects direct no-Origin feedback payload requests", async ({ request }) => {
  const widgetKey = await getCamauditWidgetKey(request);
  const response = await request.get(`/w/data/${widgetKey}/feedback-button`);

  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: "origin required" });

  const spoofed = await request.get(`/w/data/${widgetKey}/feedback-button`, {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  expect(spoofed.status()).toBe(403);
});

test("rejects direct no-Origin public wall widget reads for allowlisted products", async ({ request }) => {
  const widgetKey = await getCamauditWidgetKey(request);
  const response = await request.get(`/w/data/${widgetKey}/wall-grid`);

  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: "origin required" });
});

test("invalidates public widget data cache after approved customer attribution changes", async ({ request }) => {
  const product = await getProductBySlug(request, "camaudit-v2");
  const unique = Date.now();
  const originalName = `E2E Cache Customer ${unique}`;
  const updatedName = `E2E Cache Renamed ${unique}`;
  const quote = `E2E cache invalidation quote ${unique}`;
  let customerId: string | null = null;
  let testimonialId: string | null = null;

  try {
    const customerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: originalName,
        email: `e2e-cache-${unique}@example.test`,
      },
    });
    await expect(customerResponse).toBeOK();
    customerId = ((await customerResponse.json()) as { id: string }).id;

    const testimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: customerId,
        product_id: product.id,
        quote,
        source: "manual",
        rating: 5,
        approved: true,
      },
    });
    await expect(testimonialResponse).toBeOK();
    testimonialId = ((await testimonialResponse.json()) as { id: string }).id;

    const first = await request.get(`/w/data/${product.widget_public_key}/wall-grid`, {
      headers: { Origin: "https://app.camaudit.io" },
    });
    await expect(first).toBeOK();
    expect(first.headers()["cache-control"]).toBe("public, max-age=300");
    const firstPayload = await first.json() as { __html: string };
    expect(firstPayload.__html).toContain(quote);
    expect(firstPayload.__html).toContain(originalName);

    const patch = await request.patch(`/api/admin/customers/${customerId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { name: updatedName },
    });
    await expect(patch).toBeOK();

    const second = await request.get(`/w/data/${product.widget_public_key}/wall-grid`, {
      headers: { Origin: "https://app.camaudit.io" },
    });
    await expect(second).toBeOK();
    const secondPayload = await second.json() as { __html: string };
    expect(secondPayload.__html).toContain(quote);
    expect(secondPayload.__html).toContain(updatedName);
    expect(secondPayload.__html).not.toContain(originalName);
  } finally {
    if (testimonialId) {
      await request.delete(`/api/admin/testimonials/${testimonialId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
    if (customerId) {
      await request.delete(`/api/admin/customers/${customerId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
  }
});

test("invalidates single quote and rating badge caches after testimonial changes", async ({ request }) => {
  const product = await getProductBySlug(request, "ventora-crm");
  const unique = Date.now();
  const customerName = `E2E Variant Cache Customer ${unique}`;
  const quote = `E2E variant cache quote ${unique}`;
  let customerId: string | null = null;
  let testimonialId: string | null = null;

  try {
    const customerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: customerName,
        email: `e2e-variant-cache-${unique}@example.test`,
      },
    });
    await expect(customerResponse).toBeOK();
    customerId = ((await customerResponse.json()) as { id: string }).id;

    const testimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: customerId,
        product_id: product.id,
        quote,
        source: "manual",
        rating: 5,
        approved: true,
      },
    });
    await expect(testimonialResponse).toBeOK();
    testimonialId = ((await testimonialResponse.json()) as { id: string }).id;

    const firstSingleQuote = await request.get(`/w/data/${product.widget_public_key}/single-quote`, {
      headers: { Origin: "https://crm.ventoralabs.com" },
    });
    await expect(firstSingleQuote).toBeOK();
    const firstSingleQuotePayload = await firstSingleQuote.json() as { testimonial: unknown; __html: string };
    expect(firstSingleQuotePayload.testimonial).toBeNull();
    expect(firstSingleQuotePayload.__html).not.toContain(quote);

    const firstRatingBadge = await request.get(`/w/data/${product.widget_public_key}/rating-badge`, {
      headers: { Origin: "https://crm.ventoralabs.com" },
    });
    await expect(firstRatingBadge).toBeOK();
    const firstRatingPayload = await firstRatingBadge.json() as { average_rating: number; total_count: number; __html: string };
    expect(firstRatingPayload).toEqual(expect.objectContaining({
      average_rating: 5,
      total_count: 1,
    }));

    const patch = await request.patch(`/api/admin/testimonials/${testimonialId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { featured: true, rating: 1 },
    });
    await expect(patch).toBeOK();

    const secondSingleQuote = await request.get(`/w/data/${product.widget_public_key}/single-quote`, {
      headers: { Origin: "https://crm.ventoralabs.com" },
    });
    await expect(secondSingleQuote).toBeOK();
    const secondSingleQuotePayload = await secondSingleQuote.json() as { __html: string };
    expect(secondSingleQuotePayload.__html).toContain(quote);
    expect(secondSingleQuotePayload.__html).toContain(customerName);

    const secondRatingBadge = await request.get(`/w/data/${product.widget_public_key}/rating-badge`, {
      headers: { Origin: "https://crm.ventoralabs.com" },
    });
    await expect(secondRatingBadge).toBeOK();
    const secondRatingPayload = await secondRatingBadge.json() as { average_rating: number; total_count: number; __html: string };
    expect(secondRatingPayload).toEqual(expect.objectContaining({
      average_rating: 1,
      total_count: 1,
    }));
  } finally {
    if (testimonialId) {
      await request.delete(`/api/admin/testimonials/${testimonialId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
    if (customerId) {
      await request.delete(`/api/admin/customers/${customerId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
  }
});

test("rejects malformed public ingest JSON from an allowed authenticated origin", async ({ request }) => {
  const widgetKey = await getCamauditWidgetKey(request);
  const response = await request.post(`/w/ingest/${widgetKey}`, {
    headers: {
      Origin: "https://app.camaudit.io",
      "Content-Type": "application/json",
    },
    data: null,
  });

  expect(response.status()).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "feedback body must be a JSON object" });
});

test("rejects invalid preview widget pages before serving loader HTML", async ({ request }) => {
  const response = await request.get("/preview/camaudit-v2/not-a-widget");

  expect(response.status()).toBe(400);
  expect(response.headers()["content-type"]).toMatch(/application\/json/);
  await expect(response.json()).resolves.toEqual({ error: "unknown widget type: not-a-widget" });
});

test("serves preview data for every widget variant", async ({ request }) => {
  const widgetKey = await getWidgetKeyBySlug(request, "ventora-crm");

  for (const widget of ["wall-grid", "wall-carousel", "single-quote", "rating-badge", "feedback-button"]) {
    const response = await request.get(`/preview/data/${widgetKey}/${widget}`);
    await expect(response, widget).toBeOK();
    const body = await response.json();
    expect(body.__html, widget).toEqual(expect.any(String));
    expect(body.__css, widget).toEqual(expect.any(String));
    if (widget === "rating-badge") {
      // With no approved ratings the badge renders nothing (never a misleading 0.0).
      expect(body.__html).toBe("");
      expect(body.__html).not.toContain("0.0 out of 5");
    }
    if (widget === "feedback-button") {
      expect(body.ingest_url).toMatch(/\/preview\/ingest\/wk_[0-9a-f]{32}$/);
      expect(body.ingest_headers).toEqual({ "X-Ventora-CSRF": "1" });
      expect(body.__js).toBeUndefined();
    }
  }
});

test("renders feedback button in the admin preview sandbox", async ({ page }) => {
  await page.goto("/preview/camaudit-v2/feedback-button");

  await expect(page.locator("text=Preview mode")).toBeVisible();
  await expect(page.locator("css=div").filter({ hasText: "Send feedback" }).first()).toBeVisible();
});

test("submits feedback through the admin preview sandbox", async ({ page, request }) => {
  const widgetKey = await getCamauditWidgetKey(request);
  const title = `E2E preview feedback ${Date.now()}`;
  let feedbackId: string | null = null;

  try {
    await page.goto("/preview/camaudit-v2/feedback-button");
    await page.getByRole("button", { name: "Send Feedback" }).click();
    await page.locator("#vtTitle").fill(title);
    await page.locator("#vtBody").fill("Preview sandbox feedback submission check.");

    const body = await page.evaluate(async ({ key, feedbackTitle }) => {
      const response = await fetch(`/preview/ingest/${key}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ventora-CSRF": "1",
        },
        body: JSON.stringify({
          type: "general",
          title: feedbackTitle,
          body: "Preview sandbox feedback submission check.",
        }),
      });
      return { status: response.status, body: await response.json() as { id?: string } };
    }, { key: widgetKey, feedbackTitle: title });
    expect(body.status).toBe(201);
    expect(body.body.id).toEqual(expect.any(String));
    feedbackId = body.body.id ?? null;

    const created = await request.get("/api/admin/feedback?limit=200");
    await expect(created).toBeOK();
    const feedback = await created.json() as { items: Array<{ id: string; title: string }> };
    expect(feedback.items).toContainEqual(expect.objectContaining({
      id: feedbackId,
      title,
    }));
  } finally {
    if (feedbackId) {
      const cleanup = await request.delete(`/api/admin/feedback/${feedbackId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
      expect([204, 404]).toContain(cleanup.status());
    }
  }
});

test("rejects preview ingest mutations without CSRF protection", async ({ request }) => {
  const widgetKey = await getCamauditWidgetKey(request);
  const missingHeader = await request.post(`/preview/ingest/${widgetKey}`, {
    data: {
      type: "general",
      title: "Missing preview CSRF",
    },
  });
  expect(missingHeader.status()).toBe(403);

  const crossOrigin = await request.post(`/preview/ingest/${widgetKey}`, {
    headers: {
      "X-Ventora-CSRF": "1",
      Origin: "https://evil.example",
    },
    data: {
      type: "general",
      title: "Cross-origin preview CSRF",
    },
  });
  expect(crossOrigin.status()).toBe(403);
});

test("runs media upload customer reference public serve and delete lifecycle", async ({ request }) => {
  const unique = Date.now();
  let customerId: string | null = null;
  let mediaKey: string | null = null;

  try {
    const upload = await request.post("/api/admin/media", {
      headers: {
        "X-Ventora-CSRF": "1",
        "Content-Type": "image/png",
      },
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    expect(upload.status()).toBe(201);
    const uploaded = await upload.json() as { key: string; content_type: string; size: number };
    mediaKey = uploaded.key;
    expect(uploaded).toEqual(expect.objectContaining({
      content_type: "image/png",
      size: 8,
    }));

    const customerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: `E2E media customer ${unique}`,
        email: `e2e-media-${unique}@example.test`,
      },
    });
    await expect(customerResponse).toBeOK();
    customerId = ((await customerResponse.json()) as { id: string }).id;

    await expect(await request.patch(`/api/admin/customers/${customerId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { photo_r2_key: mediaKey },
    })).toBeOK();

    const publicMedia = await request.get(`/${mediaKey}`);
    await expect(publicMedia).toBeOK();
    expect(publicMedia.headers()["content-type"]).toContain("image/png");
    expect(publicMedia.headers()["x-content-type-options"]).toBe("nosniff");

    const deleteReferenced = await request.delete(`/api/admin/media/${mediaKey}`, {
      headers: { "X-Ventora-CSRF": "1" },
    });
    expect(deleteReferenced.status()).toBe(409);

    await expect(await request.patch(`/api/admin/customers/${customerId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { photo_r2_key: null },
    })).toBeOK();

    const deleteUnreferenced = await request.delete(`/api/admin/media/${mediaKey}`, {
      headers: { "X-Ventora-CSRF": "1" },
    });
    expect([204, 404]).toContain(deleteUnreferenced.status());

    const deletedPublicMedia = await request.get(`/${mediaKey}`);
    expect(deletedPublicMedia.status()).toBe(404);
    mediaKey = null;
  } finally {
    if (customerId) {
      await request.delete(`/api/admin/customers/${customerId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
    if (mediaKey) {
      await request.delete(`/api/admin/media/${mediaKey}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
  }
});

test("merge cleans up the source customer's managed media asset", async ({ request }) => {
  const unique = Date.now();
  let sourceCustomerId: string | null = null;
  let targetCustomerId: string | null = null;
  let mediaKey: string | null = null;

  try {
    const upload = await request.post("/api/admin/media", {
      headers: {
        "X-Ventora-CSRF": "1",
        "Content-Type": "image/png",
      },
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    expect(upload.status()).toBe(201);
    mediaKey = ((await upload.json()) as { key: string }).key;

    const sourceCustomer = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: `E2E merge media source ${unique}`,
        email: `e2e-merge-media-source-${unique}@example.test`,
      },
    });
    await expect(sourceCustomer).toBeOK();
    sourceCustomerId = ((await sourceCustomer.json()) as { id: string }).id;

    const targetCustomer = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: `E2E merge media target ${unique}`,
        email: `e2e-merge-media-target-${unique}@example.test`,
      },
    });
    await expect(targetCustomer).toBeOK();
    targetCustomerId = ((await targetCustomer.json()) as { id: string }).id;

    await expect(await request.patch(`/api/admin/customers/${sourceCustomerId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { photo_r2_key: mediaKey },
    })).toBeOK();

    await expect(await request.get(`/${mediaKey}`)).toBeOK();

    await expect(await request.post(`/api/admin/customers/${targetCustomerId}/merge`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { source_id: sourceCustomerId },
    })).toBeOK();
    sourceCustomerId = null;

    const deletedPublicMedia = await request.get(`/${mediaKey}`);
    expect(deletedPublicMedia.status()).toBe(404);
    mediaKey = null;
  } finally {
    if (sourceCustomerId) {
      await request.delete(`/api/admin/customers/${sourceCustomerId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
    if (targetCustomerId) {
      await request.delete(`/api/admin/customers/${targetCustomerId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
    if (mediaKey) {
      await request.delete(`/api/admin/media/${mediaKey}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
  }
});

test("serves widget loader without unsafe eval", async ({ request }) => {
  const response = await request.get("/w/v1.js");

  await expect(response).toBeOK();
  const body = await response.text();
  expect(body).not.toContain("new Function");
  expect(body).not.toContain("eval(");
  expect(body).toContain("initFeedbackButton");
});
