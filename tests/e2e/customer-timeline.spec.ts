import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

interface Product {
  id: string;
  slug: string;
}

async function getCamauditProduct(request: APIRequestContext): Promise<Product> {
  return getProductBySlug(request, "camaudit-v2");
}

async function getProductBySlug(request: APIRequestContext, slug: string): Promise<Product> {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();

  const products = await response.json() as Product[];
  const product = products.find((p) => p.slug === slug);
  expect(product).toBeTruthy();
  return product!;
}

async function deleteIfPresent(request: APIRequestContext, path: string) {
  const response = await request.delete(path, { headers: { "X-Ventora-CSRF": "1" } });
  expect([200, 204, 404]).toContain(response.status());
}

test("customer detail shows testimonials feedback and reviews in one activity timeline", async ({ page, request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  const customerName = `E2E Timeline Customer ${unique}`;
  const quote = `E2E timeline testimonial ${unique}`;
  const feedbackTitle = `E2E timeline feedback ${unique}`;
  const reviewBody = `E2E timeline review ${unique}`;

  let customerId: string | null = null;
  let testimonialId: string | null = null;
  let feedbackId: string | null = null;
  let reviewId: string | null = null;

  try {
    const customerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: customerName,
        email: `e2e-timeline-${unique}@example.test`,
        company: "Ventora E2E",
        product_ids: [product.id],
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
      },
    });
    await expect(testimonialResponse).toBeOK();
    testimonialId = ((await testimonialResponse.json()) as { id: string }).id;

    const feedbackResponse = await request.post("/api/admin/feedback", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: customerId,
        product_id: product.id,
        type: "feature_request",
        title: feedbackTitle,
        body: "Timeline feedback body",
      },
    });
    await expect(feedbackResponse).toBeOK();
    feedbackId = ((await feedbackResponse.json()) as { id: string }).id;

    const reviewImportResponse = await request.post("/api/admin/reviews/import/manual", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        product_id: product.id,
        body: reviewBody,
        author_name: customerName,
        rating: 4,
      },
    });
    await expect(reviewImportResponse).toBeOK();

    const reviewsResponse = await request.get(`/api/admin/reviews?product_id=${product.id}&source=manual&limit=200`);
    await expect(reviewsResponse).toBeOK();
    const reviews = await reviewsResponse.json() as { reviews: Array<{ id: string; body: string }> };
    reviewId = reviews.reviews.find((review) => review.body === reviewBody)?.id ?? null;
    expect(reviewId).toBeTruthy();

    const linkReviewResponse = await request.patch(`/api/admin/reviews/${reviewId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { customer_id: customerId },
    });
    await expect(linkReviewResponse).toBeOK();

    await page.goto("/customers");
    await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
    await page.getByPlaceholder(/Search by name/).fill(customerName);
    await expect(page.getByText(customerName)).toBeVisible();
    await page.getByText(customerName).click();

    await expect(page.getByText(customerName).last()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Activity Timeline" })).toBeVisible();
    await expect(page.getByText(quote)).toBeVisible();
    await expect(page.getByText(feedbackTitle)).toBeVisible();
    await expect(page.getByText(reviewBody)).toBeVisible();
    await expect(page.getByRole("button", { name: /Testimonials/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Feedback/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Reviews/ })).toHaveCount(0);
  } finally {
    if (reviewId) await deleteIfPresent(request, `/api/admin/reviews/${reviewId}`);
    if (feedbackId) await deleteIfPresent(request, `/api/admin/feedback/${feedbackId}`);
    if (testimonialId) await deleteIfPresent(request, `/api/admin/testimonials/${testimonialId}`);
    if (customerId) await deleteIfPresent(request, `/api/admin/customers/${customerId}`);
  }
});

test("content-created product links disappear after the last content row is removed", async ({ request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  let customerId: string | null = null;
  let explicitCustomerId: string | null = null;
  let testimonialId: string | null = null;
  let explicitTestimonialId: string | null = null;

  try {
    const customerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: `E2E content link ${unique}`,
        email: `e2e-content-link-${unique}@example.test`,
      },
    });
    await expect(customerResponse).toBeOK();
    customerId = ((await customerResponse.json()) as { id: string }).id;

    const testimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: customerId,
        product_id: product.id,
        quote: `E2E content link cleanup ${unique}`,
        source: "manual",
      },
    });
    await expect(testimonialResponse).toBeOK();
    testimonialId = ((await testimonialResponse.json()) as { id: string }).id;

    let detail = await (await request.get(`/api/admin/customers/${customerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).toContain(product.id);

    const deleteTestimonial = await request.delete(`/api/admin/testimonials/${testimonialId}`, {
      headers: { "X-Ventora-CSRF": "1" },
    });
    expect([200, 204]).toContain(deleteTestimonial.status());
    testimonialId = null;

    detail = await (await request.get(`/api/admin/customers/${customerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).not.toContain(product.id);

    const explicitCustomerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: `E2E explicit link ${unique}`,
        email: `e2e-explicit-link-${unique}@example.test`,
        product_ids: [product.id],
      },
    });
    await expect(explicitCustomerResponse).toBeOK();
    explicitCustomerId = ((await explicitCustomerResponse.json()) as { id: string }).id;

    const explicitTestimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: explicitCustomerId,
        product_id: product.id,
        quote: `E2E explicit link persists ${unique}`,
        source: "manual",
      },
    });
    await expect(explicitTestimonialResponse).toBeOK();
    explicitTestimonialId = ((await explicitTestimonialResponse.json()) as { id: string }).id;

    const deleteExplicitTestimonial = await request.delete(`/api/admin/testimonials/${explicitTestimonialId}`, {
      headers: { "X-Ventora-CSRF": "1" },
    });
    expect([200, 204]).toContain(deleteExplicitTestimonial.status());
    explicitTestimonialId = null;

    detail = await (await request.get(`/api/admin/customers/${explicitCustomerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).toContain(product.id);
  } finally {
    if (testimonialId) await deleteIfPresent(request, `/api/admin/testimonials/${testimonialId}`);
    if (explicitTestimonialId) await deleteIfPresent(request, `/api/admin/testimonials/${explicitTestimonialId}`);
    if (customerId) await deleteIfPresent(request, `/api/admin/customers/${customerId}`);
    if (explicitCustomerId) await deleteIfPresent(request, `/api/admin/customers/${explicitCustomerId}`);
  }
});

test("admin product settings omit retired products", async ({ request }) => {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();

  const products = await response.json() as Product[];
  expect(products.map((product) => product.slug)).not.toEqual(expect.arrayContaining(["retired-product-01", "retired-product-05"]));
});

test("manual promotion review relink and merge preserve product link provenance", async ({ request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  let promotedCustomerId: string | null = null;
  let promotedTestimonialId: string | null = null;
  let reviewCustomerAId: string | null = null;
  let reviewCustomerBId: string | null = null;
  let reviewId: string | null = null;
  let mergeSourceId: string | null = null;
  let mergeTargetId: string | null = null;
  let mergeTestimonialId: string | null = null;

  try {
    const promotedCustomerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: `E2E promoted link ${unique}`,
        email: `e2e-promoted-link-${unique}@example.test`,
      },
    });
    await expect(promotedCustomerResponse).toBeOK();
    promotedCustomerId = ((await promotedCustomerResponse.json()) as { id: string }).id;

    const promotedTestimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: promotedCustomerId,
        product_id: product.id,
        quote: `E2E promoted content ${unique}`,
        source: "manual",
      },
    });
    await expect(promotedTestimonialResponse).toBeOK();
    promotedTestimonialId = ((await promotedTestimonialResponse.json()) as { id: string }).id;

    const promoteResponse = await request.post(`/api/admin/customers/${promotedCustomerId}/link-product`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { product_id: product.id },
    });
    await expect(promoteResponse).toBeOK();

    const deletePromotedTestimonial = await request.delete(`/api/admin/testimonials/${promotedTestimonialId}`, {
      headers: { "X-Ventora-CSRF": "1" },
    });
    expect([200, 204]).toContain(deletePromotedTestimonial.status());
    promotedTestimonialId = null;

    let detail = await (await request.get(`/api/admin/customers/${promotedCustomerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).toContain(product.id);

    const customerAResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: { name: `E2E review A ${unique}`, email: `e2e-review-a-${unique}@example.test` },
    });
    await expect(customerAResponse).toBeOK();
    reviewCustomerAId = ((await customerAResponse.json()) as { id: string }).id;

    const customerBResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: { name: `E2E review B ${unique}`, email: `e2e-review-b-${unique}@example.test` },
    });
    await expect(customerBResponse).toBeOK();
    reviewCustomerBId = ((await customerBResponse.json()) as { id: string }).id;

    const reviewBody = `E2E relink review ${unique}`;
    const reviewImportResponse = await request.post("/api/admin/reviews/import/manual", {
      headers: { "X-Ventora-CSRF": "1" },
      data: { product_id: product.id, body: reviewBody, author_name: "E2E", rating: 4 },
    });
    await expect(reviewImportResponse).toBeOK();
    const reviewsResponse = await request.get(`/api/admin/reviews?product_id=${product.id}&source=manual&limit=200`);
    await expect(reviewsResponse).toBeOK();
    const reviews = await reviewsResponse.json() as { reviews: Array<{ id: string; body: string }> };
    reviewId = reviews.reviews.find((review) => review.body === reviewBody)?.id ?? null;
    expect(reviewId).toBeTruthy();

    await expect(await request.patch(`/api/admin/reviews/${reviewId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { customer_id: reviewCustomerAId },
    })).toBeOK();
    await expect(await request.patch(`/api/admin/reviews/${reviewId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { customer_id: reviewCustomerBId },
    })).toBeOK();

    detail = await (await request.get(`/api/admin/customers/${reviewCustomerAId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).not.toContain(product.id);
    detail = await (await request.get(`/api/admin/customers/${reviewCustomerBId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).toContain(product.id);

    const mergeSourceResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: { name: `E2E merge source ${unique}`, email: `e2e-merge-source-${unique}@example.test` },
    });
    await expect(mergeSourceResponse).toBeOK();
    mergeSourceId = ((await mergeSourceResponse.json()) as { id: string }).id;

    const mergeTargetResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: { name: `E2E merge target ${unique}`, email: `e2e-merge-target-${unique}@example.test` },
    });
    await expect(mergeTargetResponse).toBeOK();
    mergeTargetId = ((await mergeTargetResponse.json()) as { id: string }).id;

    const mergeTestimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: mergeSourceId,
        product_id: product.id,
        quote: `E2E merge content ${unique}`,
        source: "manual",
      },
    });
    await expect(mergeTestimonialResponse).toBeOK();
    mergeTestimonialId = ((await mergeTestimonialResponse.json()) as { id: string }).id;

    const mergeResponse = await request.post(`/api/admin/customers/${mergeTargetId}/merge`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { source_id: mergeSourceId },
    });
    await expect(mergeResponse).toBeOK();
    mergeSourceId = null;

    const deleteMergeTestimonial = await request.delete(`/api/admin/testimonials/${mergeTestimonialId}`, {
      headers: { "X-Ventora-CSRF": "1" },
    });
    expect([200, 204]).toContain(deleteMergeTestimonial.status());
    mergeTestimonialId = null;

    detail = await (await request.get(`/api/admin/customers/${mergeTargetId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).not.toContain(product.id);
  } finally {
    if (promotedTestimonialId) await deleteIfPresent(request, `/api/admin/testimonials/${promotedTestimonialId}`);
    if (reviewId) await deleteIfPresent(request, `/api/admin/reviews/${reviewId}`);
    if (mergeTestimonialId) await deleteIfPresent(request, `/api/admin/testimonials/${mergeTestimonialId}`);
    if (promotedCustomerId) await deleteIfPresent(request, `/api/admin/customers/${promotedCustomerId}`);
    if (reviewCustomerAId) await deleteIfPresent(request, `/api/admin/customers/${reviewCustomerAId}`);
    if (reviewCustomerBId) await deleteIfPresent(request, `/api/admin/customers/${reviewCustomerBId}`);
    if (mergeSourceId) await deleteIfPresent(request, `/api/admin/customers/${mergeSourceId}`);
    if (mergeTargetId) await deleteIfPresent(request, `/api/admin/customers/${mergeTargetId}`);
  }
});

test("feedback delete and review unlink clean up content-derived product membership", async ({ request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  let customerId: string | null = null;
  let feedbackId: string | null = null;
  let reviewId: string | null = null;

  try {
    const customerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: `E2E cleanup customer ${unique}`,
        email: `e2e-cleanup-${unique}@example.test`,
      },
    });
    await expect(customerResponse).toBeOK();
    customerId = ((await customerResponse.json()) as { id: string }).id;

    const feedbackResponse = await request.post("/api/admin/feedback", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: customerId,
        product_id: product.id,
        type: "general",
        title: `E2E cleanup feedback ${unique}`,
      },
    });
    await expect(feedbackResponse).toBeOK();
    feedbackId = ((await feedbackResponse.json()) as { id: string }).id;

    let detail = await (await request.get(`/api/admin/customers/${customerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).toContain(product.id);

    const deleteFeedback = await request.delete(`/api/admin/feedback/${feedbackId}`, {
      headers: { "X-Ventora-CSRF": "1" },
    });
    expect([200, 204]).toContain(deleteFeedback.status());
    feedbackId = null;

    detail = await (await request.get(`/api/admin/customers/${customerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).not.toContain(product.id);

    const reviewBody = `E2E unlink review ${unique}`;
    const importResponse = await request.post("/api/admin/reviews/import/manual", {
      headers: { "X-Ventora-CSRF": "1" },
      data: { product_id: product.id, body: reviewBody, author_name: "E2E", rating: 4 },
    });
    await expect(importResponse).toBeOK();

    const reviewsResponse = await request.get(`/api/admin/reviews?product_id=${product.id}&source=manual&limit=200`);
    await expect(reviewsResponse).toBeOK();
    const reviews = await reviewsResponse.json() as { reviews: Array<{ id: string; body: string }> };
    reviewId = reviews.reviews.find((review) => review.body === reviewBody)?.id ?? null;
    expect(reviewId).toBeTruthy();

    await expect(await request.patch(`/api/admin/reviews/${reviewId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { customer_id: customerId },
    })).toBeOK();

    detail = await (await request.get(`/api/admin/customers/${customerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).toContain(product.id);

    await expect(await request.patch(`/api/admin/reviews/${reviewId}`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: { customer_id: null },
    })).toBeOK();

    detail = await (await request.get(`/api/admin/customers/${customerId}`)).json() as { products: Product[] };
    expect(detail.products.map((p) => p.id)).not.toContain(product.id);
  } finally {
    if (feedbackId) await deleteIfPresent(request, `/api/admin/feedback/${feedbackId}`);
    if (reviewId) await deleteIfPresent(request, `/api/admin/reviews/${reviewId}`);
    if (customerId) await deleteIfPresent(request, `/api/admin/customers/${customerId}`);
  }
});
