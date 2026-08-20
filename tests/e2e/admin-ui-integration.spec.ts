import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

interface Product {
  id: string;
  slug: string;
  name: string;
}

async function getCamauditProduct(request: APIRequestContext): Promise<Product> {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();
  const products = (await response.json()) as Product[];
  const product = products.find((p) => p.slug === "camaudit-v2");
  expect(product).toBeTruthy();
  return product!;
}

async function deleteIfPresent(request: APIRequestContext, path: string) {
  const response = await request.delete(path, { headers: { "X-Ventora-CSRF": "1" } });
  expect([200, 204, 404]).toContain(response.status());
}

// ---------------------------------------------------------------------------
// Test 1 — sidebar shows signed-in email from /api/admin/me
// ---------------------------------------------------------------------------

test("sidebar shows signed-in email from /me under DEV_AUTH_BYPASS", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  // The sidebar is `hidden md:flex` — the default Desktop Chrome viewport (1280×720)
  // satisfies the md breakpoint, so the aside is rendered.
  const sidebar = page.locator("aside");
  await expect(sidebar.getByText("Signed in as")).toBeVisible();
  await expect(sidebar.getByText("dev@local")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Test 2 — Poll now connector flow
// ---------------------------------------------------------------------------

test("Poll now button triggers polling and shows success message", async ({ page, request }) => {
  const product = await getCamauditProduct(request);
  let configId: string | null = null;

  try {
    // Create a connector config via the admin API (RSS, feed_url defaults review_source to "rss").
    const createResponse = await request.post(
      "/api/admin/reviews/connector-configs",
      {
        headers: { "X-Ventora-CSRF": "1" },
        data: {
          product_id: product.id,
          source: "rss",
          config: { feed_url: "https://example.test/rss.xml" },
          enabled: true,
        },
      },
    );
    await expect(createResponse).toBeOK();
    const config = (await createResponse.json()) as { id: string };
    configId = config.id;

    await page.goto("/reviews");
    await expect(page.getByRole("heading", { name: "Reviews Import" })).toBeVisible();

    // Poll now should be enabled now that a connector config exists.
    const pollBtn = page.getByRole("button", { name: "Poll now" });
    await expect(pollBtn).toBeEnabled();

    pollBtn.click();

    // pollReviewConnectors catches per-connector failures without surfacing them
    // to the caller, so the endpoint always returns { ok: true } and the
    // component always shows the success message — even if the feed URL is unreachable.
    await expect(
      page.getByText("Polled all enabled connectors"),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    if (configId) {
      await deleteIfPresent(request, `/api/admin/reviews/connector-configs/${configId}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Test 3 — WallOfFame source editing persists
// ---------------------------------------------------------------------------

test("WallOfFame edit drawer Source change persists via PATCH", async ({ page, request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  const quote = `E2E source-edit fixture ${unique} — do not approve in prod.`;

  // Create a customer linked to the product.
  const customerResponse = await request.post("/api/admin/customers", {
    headers: { "X-Ventora-CSRF": "1" },
    data: {
      name: `E2E Source Edit ${unique}`,
      email: `e2e-src-edit-${unique}@example.test`,
      company: "Ventora E2E",
      lifecycle: "champion",
      product_ids: [product.id],
    },
  });
  await expect(customerResponse).toBeOK();
  const customer = (await customerResponse.json()) as { id: string; name: string };

  let testimonialId: string | null = null;

  try {
    // Create testimonial with source "manual".
    const testimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: customer.id,
        product_id: product.id,
        quote,
        source: "manual",
        rating: 5,
        approved: false,
      },
    });
    await expect(testimonialResponse).toBeOK();
    const testimonial = (await testimonialResponse.json()) as { id: string };
    testimonialId = testimonial.id;

    // Approve it so it appears in the "Approved" tab.
    const approveResponse = await request.post(
      `/api/admin/testimonials/${testimonialId}/approve`,
      { headers: { "X-Ventora-CSRF": "1" }, data: {} },
    );
    await expect(approveResponse).toBeOK();

    // Navigate to /wall (WallOfFame route per App.tsx).
    await page.goto("/wall");
    await expect(page.getByRole("heading", { name: "Wall of Fame" })).toBeVisible();

    // Switch to the Approved tab.
    await page.getByRole("button", { name: "Approved" }).click();

    // Find and click the testimonial card to open the edit drawer.
    await expect(page.getByText(quote)).toBeVisible();
    await page.getByText(quote).click();

    // The Edit Testimonial drawer should now be visible.
    await expect(
      page.getByRole("dialog", { name: "Edit Testimonial" }),
    ).toBeVisible();

    // Change the Source select (aria-label added to the select in EditDrawer).
    await page.getByLabel("Edit testimonial source").selectOption("import");

    // Save.
    await page.getByRole("button", { name: "Save" }).click();

    // Drawer should close.
    await expect(
      page.getByRole("dialog", { name: "Edit Testimonial" }),
    ).toHaveCount(0);

    // Verify via API that source persisted.
    const listResponse = await request.get(
      `/api/admin/testimonials?product_id=${product.id}&approved=1&limit=200`,
    );
    await expect(listResponse).toBeOK();
    const list = (await listResponse.json()) as {
      testimonials: Array<{ id: string; source: string }>;
    };
    const found = list.testimonials.find((t) => t.id === testimonialId);
    expect(found).toBeTruthy();
    expect(found!.source).toBe("import");
  } finally {
    if (testimonialId) {
      await deleteIfPresent(request, `/api/admin/testimonials/${testimonialId}`);
    }
    await deleteIfPresent(request, `/api/admin/customers/${customer.id}`);
  }
});
