import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

const PRODUCT_SLUG = "camaudit-v2";
const DISPLAY_ORIGIN = "https://app.camaudit.io";
const FEEDBACK_ORIGIN = "https://app.camaudit.io";

interface ProductRow {
  id: string;
  slug: string;
  widget_public_key: string;
}

async function getProduct(request: APIRequestContext): Promise<ProductRow> {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();
  const products = (await response.json()) as ProductRow[];
  const product = products.find((p) => p.slug === PRODUCT_SLUG);
  expect(product).toBeTruthy();
  return product!;
}

async function deleteIfPresent(request: APIRequestContext, path: string) {
  const response = await request.delete(path, { headers: { "X-Ventora-CSRF": "1" } });
  expect([200, 204, 404]).toContain(response.status());
}

test("canonical business flow: create customer + testimonial, approve, widget serves it, feedback ingest lands in inbox", async ({
  request,
}) => {
  const product = await getProduct(request);
  const unique = Date.now();

  const customerName = `E2E Flow Customer ${unique}`;
  const quote = `E2E flow testimonial ${unique} — canonical story verification.`;
  const feedbackTitle = `E2E flow feedback ${unique}`;
  const feedbackBody = "Automated canonical business flow feedback submission.";

  let customerId: string | null = null;
  let testimonialId: string | null = null;
  let feedbackId: string | null = null;

  try {
    // Step 1: Create a customer linked to the product.
    const customerResponse = await request.post("/api/admin/customers", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        name: customerName,
        email: `e2e-flow-${unique}@example.test`,
        company: "Ventora E2E",
        lifecycle: "champion",
        product_ids: [product.id],
      },
    });
    await expect(customerResponse).toBeOK();
    const customer = (await customerResponse.json()) as { id: string; name: string };
    customerId = customer.id;

    // Step 2: Attach a testimonial to that customer for the product (unapproved).
    const testimonialResponse = await request.post("/api/admin/testimonials", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        customer_id: customerId,
        product_id: product.id,
        quote,
        source: "manual",
        rating: 5,
        approved: false,
      },
    });
    await expect(testimonialResponse).toBeOK();
    const testimonial = (await testimonialResponse.json()) as { id: string; approved: number };
    testimonialId = testimonial.id;
    expect(testimonial.approved).toBe(0);

    // Step 3: Approve the testimonial.
    const approveResponse = await request.post(`/api/admin/testimonials/${testimonialId}/approve`, {
      headers: { "X-Ventora-CSRF": "1" },
      data: {},
    });
    await expect(approveResponse).toBeOK();
    await expect(await approveResponse.json()).toEqual(expect.objectContaining({ approved: 1 }));

    // Step 4: Fetch the PUBLIC wall-grid widget data from an allowed origin and assert the
    // approved testimonial's quote and author appear in the returned HTML.
    const wallGridResponse = await request.get(`/w/data/${product.widget_public_key}/wall-grid`, {
      headers: { Origin: DISPLAY_ORIGIN },
    });
    await expect(wallGridResponse).toBeOK();
    const wallGridPayload = (await wallGridResponse.json()) as { __html: string };
    expect(wallGridPayload.__html).toContain(quote);
    expect(wallGridPayload.__html).toContain(customerName);

    // Step 5: Fetch the PUBLIC feedback-button payload from the authenticated product origin and
    // assert it returns an absolute CRM ingest URL.
    const feedbackButtonResponse = await request.get(`/w/data/${product.widget_public_key}/feedback-button`, {
      headers: { Origin: FEEDBACK_ORIGIN },
    });
    await expect(feedbackButtonResponse).toBeOK();
    const feedbackPayload = (await feedbackButtonResponse.json()) as { ingest_url: string; __css: string };
    expect(feedbackPayload.ingest_url).toMatch(/https?:\/\/[^"]+\/w\/ingest\/wk_[0-9a-f]{32}/);
    expect(feedbackPayload.__css).toBeTruthy();

    // Step 6: Submit feedback via the PUBLIC ingest endpoint from the allowed authenticated origin.
    const ingestPath = new URL(feedbackPayload.ingest_url).pathname;
    const ingestResponse = await request.post(ingestPath, {
      headers: { Origin: FEEDBACK_ORIGIN },
      data: {
        type: "general",
        title: feedbackTitle,
        body: feedbackBody,
      },
    });
    await expect(ingestResponse).toBeOK();
    const ingestBody = (await ingestResponse.json()) as { ok: boolean; id: string };
    expect(ingestBody).toEqual(expect.objectContaining({ ok: true, id: expect.any(String) }));
    feedbackId = ingestBody.id;

    // Step 7: Assert the feedback landed in the CRM inbox (admin API shows the new row).
    const inboxResponse = await request.get("/api/admin/feedback?limit=200");
    await expect(inboxResponse).toBeOK();
    const inbox = (await inboxResponse.json()) as { items: Array<{ id: string; title: string; body: string }> };
    expect(inbox.items).toContainEqual(
      expect.objectContaining({ id: feedbackId, title: feedbackTitle, body: feedbackBody }),
    );
  } finally {
    // Step 8: Clean up everything created.
    if (feedbackId) await deleteIfPresent(request, `/api/admin/feedback/${feedbackId}`);
    if (testimonialId) await deleteIfPresent(request, `/api/admin/testimonials/${testimonialId}`);
    if (customerId) await deleteIfPresent(request, `/api/admin/customers/${customerId}`);
  }
});
