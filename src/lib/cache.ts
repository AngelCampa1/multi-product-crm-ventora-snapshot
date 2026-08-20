/**
 * Workers Cache API helpers.
 *
 * Used for /w/data/* and /w/v1.js — public widget endpoints with a strict
 * read-mostly access pattern. We tag entries by canonical URL so they can be
 * busted precisely when a testimonial is approved / featured / unfeatured.
 *
 * No KV in v1 (cost). Cache API is free; entries live on the colo that served
 * them. Eventual consistency across colos (a few seconds) is acceptable for
 * testimonial walls.
 */

const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const DATA_CACHE_VERSION = "v2";

export function buildCacheUrl(productSlug: string, widget: string): string {
  // Synthetic, scheme-bearing URL used as the cache key. Not actually fetched.
  return `https://cache.ventora-crm.internal/${DATA_CACHE_VERSION}/w/data/${productSlug}/${widget}`;
}

// Workers exposes caches.default but @cloudflare/workers-types types CacheStorage
// without the `default` property. Cast through unknown to satisfy the compiler.
const workersCache = () => (caches as unknown as { default: Cache }).default;

export async function getCached(request: Request): Promise<Response | undefined> {
  return (await workersCache().match(request)) ?? undefined;
}

export async function putCached(
  request: Request,
  response: Response,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const cacheable = new Response(response.clone().body, response);
  cacheable.headers.set("Cache-Control", `public, s-maxage=${ttlSeconds}, max-age=${ttlSeconds}`);
  await workersCache().put(request, cacheable);
}

/**
 * Bust every widget variant for a product. Called after testimonial approval /
 * feature toggle. Worker Cache API does not support tag/prefix deletion, so we
 * enumerate the known widget variants explicitly.
 */
export async function bustProductWidgets(productSlug: string): Promise<void> {
  const variants = ["wall-grid", "wall-carousel", "single-quote", "rating-badge", "feedback-button"] as const;
  const results = await Promise.allSettled(
    variants.map((w) => workersCache().delete(buildCacheUrl(productSlug, w))),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Widget cache bust failed", result.reason);
    }
  }
}
