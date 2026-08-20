import { nowIso } from "../db/queries";
import { readResponseTextBounded, sha256Hex } from "./base";
import type { Connector, ConnectorResult } from "./base";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Schema.org / JSON-LD shape G2 may embed
// ---------------------------------------------------------------------------

interface SchemaReview {
  "@type"?: string;
  "@graph"?: unknown;
  author?: { name?: string } | string;
  reviewBody?: string;
  description?: string;
  reviewRating?: { ratingValue?: number | string };
  review?: unknown;
  reviews?: unknown;
  url?: string;
  name?: string;
}

function typeIncludes(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) return value.some((item) => typeIncludes(item, expected));
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function reviewValues(value: unknown): SchemaReview[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is SchemaReview => !!item && typeof item === "object");
}

function extractJsonLdReviews(value: unknown): SchemaReview[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractJsonLdReviews(item));

  const block = value as SchemaReview;
  const reviews: SchemaReview[] = [];

  if (typeIncludes(block["@type"], "Review")) {
    reviews.push(block);
  }

  reviews.push(...extractJsonLdReviews(block["@graph"]));
  reviews.push(...reviewValues(block.review));
  reviews.push(...reviewValues(block.reviews));

  return reviews;
}

function canonicalReviewUrl(rawUrl: string | undefined, baseUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl, baseUrl);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return null;
  }
}

async function externalIdForReview(source: "g2", reviewUrl: string | null, body: string, authorName: string | null): Promise<string> {
  if (reviewUrl) return sha256Hex(`${source}:${reviewUrl}`);
  return sha256Hex(`${source}:${body.trim().replace(/\s+/g, " ")}:${authorName?.trim() ?? ""}`);
}

export async function scrapeG2(
  productSlug: string,
  page = 1,
): Promise<ConnectorResult[]> {
  const url = `https://www.g2.com/products/${productSlug}/reviews?page=${page}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }).catch((cause) => {
    throw new Error("scrape-g2: fetch failed", { cause });
  });

  if (!res.ok) {
    throw new Error(`scrape-g2: HTTP ${res.status}`);
  }

  const html = await readResponseTextBounded(res, "scrape-g2");
  const now = nowIso();
  const results: ConnectorResult[] = [];

  // Attempt 1: JSON-LD blocks
  const ldJsonMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);

  for (const match of ldJsonMatches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }

    const items = extractJsonLdReviews(parsed);
    for (const item of items) {
      const body = item.reviewBody ?? item.description ?? item.name ?? "";
      if (!body) continue;

      const authorName =
        typeof item.author === "string"
          ? item.author
          : item.author?.name ?? null;

      const ratingRaw = item.reviewRating?.ratingValue;
      const rating = ratingRaw !== undefined ? parseFloat(String(ratingRaw)) : null;
      const validRating =
        rating !== null && !isNaN(rating) && rating >= 1 && rating <= 5 ? rating : null;

      const reviewUrl = canonicalReviewUrl(item.url, url);
      const external_id = await externalIdForReview("g2", reviewUrl, body, authorName);

      results.push({
        external_id,
        source: "g2",
        author_name: authorName,
        body,
        rating: validRating,
        source_url: reviewUrl ?? url,
        imported_at: now,
      });
    }
  }

  // Attempt 2: Look for review data in script tags containing window.gon or similar JSON payloads
  if (results.length === 0) {
    const dataMatches = html.matchAll(/\{"reviews":\[([\s\S]*?)\]}/g);
    for (const match of dataMatches) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(`{"reviews":[${match[1]}]}`);
      } catch {
        continue;
      }

      interface ReviewPayload { reviews?: SchemaReview[] }
      const data = parsed as ReviewPayload;
      if (!data.reviews) continue;

      for (const r of data.reviews) {
        const body = r.reviewBody ?? r.description ?? "";
        if (!body) continue;

        const authorName =
          typeof r.author === "string"
            ? r.author
            : r.author?.name ?? null;

        const reviewUrl = canonicalReviewUrl(r.url, url);
        const external_id = await externalIdForReview("g2", reviewUrl, body, authorName);

        results.push({
          external_id,
          source: "g2",
          author_name: authorName,
          body,
          rating: null,
          source_url: reviewUrl ?? url,
          imported_at: now,
        });
      }
    }
  }

  return results;
}

function parsePage(value: string | undefined): number {
  if (!value) return 1;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export const g2ScrapeConnector: Connector = {
  source: "g2",

  async fetch(config: Record<string, string>): Promise<ConnectorResult[]> {
    const { product_slug, page } = config;
    if (!product_slug) {
      throw new Error("scrape-g2: 'product_slug' is required");
    }
    return scrapeG2(product_slug, parsePage(page));
  },
};
