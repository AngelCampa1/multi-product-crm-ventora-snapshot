import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

interface Product {
  id: string;
  slug: string;
}

interface ConnectorConfig {
  id: string;
  product_id: string;
  source: string;
  config: Record<string, unknown>;
  enabled: boolean;
  last_status: string | null;
  last_error: string | null;
  last_inserted: number | null;
}

async function getCamauditProduct(request: APIRequestContext): Promise<Product> {
  const response = await request.get("/api/admin/settings/products");
  await expect(response).toBeOK();

  const products = await response.json() as Product[];
  const product = products.find((p) => p.slug === "camaudit-v2");
  expect(product).toBeTruthy();
  return product!;
}

async function startRssServer(xml: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url !== "/feed.xml") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/rss+xml; charset=utf-8" });
    res.end(xml);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/feed.xml`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

async function getConnectorConfig(request: APIRequestContext, configId: string): Promise<ConnectorConfig> {
  const response = await request.get("/api/admin/reviews/connector-configs");
  await expect(response).toBeOK();
  const body = await response.json() as { configs: ConnectorConfig[] };
  const config = body.configs.find((item) => item.id === configId);
  expect(config).toBeTruthy();
  return config!;
}

test("scheduled connector trigger imports an RSS review through the real poller runtime fetch and D1", async ({ request }) => {
  const product = await getCamauditProduct(request);
  const unique = Date.now();
  const reviewBody = `E2E scheduled connector review ${unique}`;
  const externalId = `e2e-scheduled-${unique}`;
  const feed = await startRssServer(`<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>Scheduled connector check</title>
    <guid>${externalId}</guid>
    <description>${reviewBody}</description>
    <pubDate>Wed, 27 May 2026 12:00:00 GMT</pubDate>
  </item>
</channel></rss>`);
  let configId: string | null = null;
  let reviewId: string | null = null;

  try {
    const createConfig = await request.post("/api/admin/reviews/connector-configs", {
      headers: { "X-Ventora-CSRF": "1" },
      data: {
        product_id: product.id,
        source: "rss",
        enabled: true,
        config: {
          feed_url: feed.url,
          review_source: "product_hunt",
        },
      },
    });
    await expect(createConfig).toBeOK();
    configId = ((await createConfig.json()) as ConnectorConfig).id;

    const run = await request.get("/__scheduled");
    await expect(run).toBeOK();

    let status: ConnectorConfig | null = null;
    await expect.poll(async () => {
      status = await getConnectorConfig(request, configId!);
      return status.last_status;
    }).toBe("ok");
    expect(status).toEqual(expect.objectContaining({
      last_status: "ok",
      last_error: null,
      last_inserted: 1,
    }));

    const dedupedRun = await request.get("/__scheduled");
    await expect(dedupedRun).toBeOK();
    await expect.poll(async () => {
      status = await getConnectorConfig(request, configId!);
      return status.last_inserted;
    }).toBe(0);
    expect(status).toEqual(expect.objectContaining({
      last_status: "ok",
      last_error: null,
      last_inserted: 0,
    }));

    const reviewsResponse = await request.get(`/api/admin/reviews?product_id=${product.id}&source=product_hunt&limit=200`);
    await expect(reviewsResponse).toBeOK();
    const reviewsBody = await reviewsResponse.json() as { reviews: Array<{ id: string; body: string; external_id: string }> };
    const review = reviewsBody.reviews.find((item) => item.external_id === externalId);
    expect(review).toEqual(expect.objectContaining({ body: reviewBody }));
    reviewId = review?.id ?? null;
  } finally {
    if (reviewId) {
      await request.delete(`/api/admin/reviews/${reviewId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
    if (configId) {
      await request.delete(`/api/admin/reviews/connector-configs/${configId}`, {
        headers: { "X-Ventora-CSRF": "1" },
      });
    }
    await feed.close();
  }
});
