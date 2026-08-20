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

  const products = await response.json() as Product[];
  const product = products.find((p) => p.slug === "camaudit-v2");
  expect(product).toBeTruthy();
  return product!;
}

async function createCamauditCustomer(request: APIRequestContext, productId: string, label: string) {
  const emailLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const response = await request.post("/api/admin/customers", {
    headers: { "X-Ventora-CSRF": "1" },
    data: {
      name: `E2E Fixture ${label}`,
      email: `e2e-${emailLabel}-${Date.now()}@example.test`,
      company: "Ventora E2E",
      lifecycle: "champion",
      product_ids: [productId],
    },
  });

  await expect(response).toBeOK();
  return await response.json() as { id: string; name: string };
}

async function deleteIfPresent(request: APIRequestContext, path: string) {
  const response = await request.delete(path, { headers: { "X-Ventora-CSRF": "1" } });
  expect([200, 204, 404]).toContain(response.status());
}

async function deleteCsvReviewsByBody(request: APIRequestContext, productId: string, body: string) {
  const response = await request.get(`/api/admin/reviews?product_id=${productId}&source=csv&limit=200`);
  if (!response.ok()) return;

  const reviews = await response.json() as { reviews: Array<{ id: string; body: string }> };
  const matches = reviews.reviews.filter((review) => review.body === body);
  await Promise.all(matches.map((review) => deleteIfPresent(request, `/api/admin/reviews/${review.id}`)));
}

test("approved customer testimonial appears in the wall-grid preview shadow DOM", async ({ page, request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  const customer = await createCamauditCustomer(request, product.id, `Testimonial ${unique}`);
  const quote = `E2E fixture testimonial ${unique} for wall-grid preview verification.`;
  let testimonialId: string | null = null;

  try {
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
    const testimonial = await testimonialResponse.json() as { id: string; approved: number };
    testimonialId = testimonial.id;
    expect(testimonial.approved).toBe(0);

    const approveResponse = await request.post(`/api/admin/testimonials/${testimonial.id}/approve`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: {},
    });
    await expect(approveResponse).toBeOK();
    await expect(await approveResponse.json()).toEqual(expect.objectContaining({ approved: 1 }));

    await page.goto(`/preview/${product.slug}/wall-grid`);

    await expect(page.getByText(quote)).toBeVisible();
    await expect(page.locator(".attribution").filter({ hasText: customer.name })).toBeVisible();
  } finally {
    if (testimonialId) await deleteIfPresent(request, `/api/admin/testimonials/${testimonialId}`);
    await deleteIfPresent(request, `/api/admin/customers/${customer.id}`);
  }
});

test("feedback status changes persist from the admin kanban detail drawer", async ({ page, request }) => {
  const product = await getCamauditProduct(request);
  const title = `E2E feedback persistence ${Date.now()}`;
  let itemId: string | null = null;

  try {
    const createResponse = await request.post("/api/admin/feedback", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        product_id: product.id,
        type: "feature_request",
        title,
        body: "Verify that status changes survive a reload and a filtered API read.",
      },
    });
    await expect(createResponse).toBeOK();
    const item = await createResponse.json() as { id: string; status: string };
    itemId = item.id;
    expect(item.status).toBe("new");

    await page.goto("/feedback");
    await expect(page.getByRole("heading", { name: "Feedback" })).toBeVisible();
    await page.getByLabel("Feedback product").selectOption(product.id);

    await page.getByText(title).click();
    await expect(page.getByRole("heading", { name: "Feedback Detail" })).toBeVisible();
    await page.getByLabel("Feedback detail status").selectOption("planned");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByRole("heading", { name: "Feedback Detail" })).toHaveCount(0);
    // A full reload resets the transient product filter to the default product.
    // Re-select CAMAudit so we assert against the right board, then confirm the
    // status change persisted server-side (re-rendered card + filtered API read).
    await page.reload();
    await page.getByLabel("Feedback product").selectOption(product.id);
    await expect(page.getByText(title)).toBeVisible();

    const plannedResponse = await request.get(`/api/admin/feedback?product_id=${product.id}&status=planned`);
    await expect(plannedResponse).toBeOK();
    const planned = await plannedResponse.json() as { items: Array<{ id: string; status: string }> };
    expect(planned.items).toContainEqual(expect.objectContaining({ id: item.id, status: "planned" }));
  } finally {
    if (itemId) await deleteIfPresent(request, `/api/admin/feedback/${itemId}`);
  }
});

test("CSV import with missing required columns surfaces no-rows-imported feedback", async ({ page, request }) => {
  const product = await getCamauditProduct(request);

  // CSV with no recognisable "body" column — only an "id" column.
  const csv = ["id,score", "1,4", "2,5"].join("\n");

  await page.goto("/reviews");
  await expect(page.getByRole("heading", { name: "Reviews Import" })).toBeVisible();
  await page.getByRole("button", { name: "CSV" }).click();

  await page.getByLabel("Import product").selectOption(product.id);
  await page.getByLabel(/CSV Text/).fill(csv);
  await page.getByRole("button", { name: "Import Reviews" }).click();

  // No rows have a body column so nothing should be inserted.
  await expect(page.getByText(/Inserted\s+0,\s+skipped\s+0/)).toBeVisible();

  // Confirm the DB received nothing from this payload.
  const reviewsResponse = await request.get(
    `/api/admin/reviews?product_id=${product.id}&source=csv&limit=200`,
  );
  await expect(reviewsResponse).toBeOK();
  const reviews = await reviewsResponse.json() as { reviews: Array<{ body: string }> };
  expect(reviews.reviews.filter((r) => r.body === "4" || r.body === "5")).toHaveLength(0);
});

test("CSV import with completely malformed data surfaces no-rows-imported feedback", async ({ page, request }) => {
  const product = await getCamauditProduct(request);

  // A single line with no delimiter — no recognisable structure.
  const csv = "this is not valid csv data at all no columns no rows";

  await page.goto("/reviews");
  await expect(page.getByRole("heading", { name: "Reviews Import" })).toBeVisible();
  await page.getByRole("button", { name: "CSV" }).click();

  await page.getByLabel("Import product").selectOption(product.id);
  await page.getByLabel(/CSV Text/).fill(csv);
  await page.getByRole("button", { name: "Import Reviews" }).click();

  // Malformed input produces no importable rows.
  await expect(page.getByText(/Inserted\s+0,\s+skipped\s+0/)).toBeVisible();
});

test("CSV review import through the admin UI dedups a re-upload", async ({ page, request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  const reviewBody = `E2E CSV review ${unique} with a stable dedup row.`;
  const csv = [
    "author_name,body,rating,source_url",
    `"E2E CSV Author","${reviewBody}",4,"https://example.test/reviews/${unique}"`,
  ].join("\n");

  try {
    await page.goto("/reviews");
    await expect(page.getByRole("heading", { name: "Reviews Import" })).toBeVisible();
    await page.getByRole("button", { name: "CSV" }).click();

    await page.getByLabel("Import product").selectOption(product.id);
    await page.getByLabel(/CSV Text/).fill(csv);
    await page.getByRole("button", { name: "Import Reviews" }).click();
    await expect(page.getByText(/Inserted\s+1,\s+skipped\s+0/)).toBeVisible();
    await expect(page.getByText(reviewBody)).toBeVisible();

    await page.getByRole("button", { name: "CSV" }).click();
    await page.getByLabel("Import product").selectOption(product.id);
    await page.getByLabel(/CSV Text/).fill(csv);
    await page.getByRole("button", { name: "Import Reviews" }).click();
    await expect(page.getByText(/Inserted\s+0,\s+skipped\s+1/)).toBeVisible();

    const reviewsResponse = await request.get(`/api/admin/reviews?product_id=${product.id}&source=csv&limit=200`);
    await expect(reviewsResponse).toBeOK();
    const reviews = await reviewsResponse.json() as { reviews: Array<{ body: string }> };
    expect(reviews.reviews.filter((review) => review.body === reviewBody)).toHaveLength(1);
  } finally {
    await deleteCsvReviewsByBody(request, product.id, reviewBody);
  }
});
