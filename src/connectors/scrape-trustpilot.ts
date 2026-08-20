import { nowIso } from "../db/queries";
import { readResponseTextBounded, sha256Hex } from "./base";
import type { Connector, ConnectorResult } from "./base";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Schema.org Review shape from Trustpilot JSON-LD
// ---------------------------------------------------------------------------

interface SchemaReview {
  "@type"?: string;
  author?: { name?: string } | string;
  reviewBody?: string;
  description?: string;
  reviewRating?: { ratingValue?: number | string };
  url?: string;
}

interface SchemaOrgBlock {
  "@type"?: string;
  "@graph"?: unknown;
  review?: unknown;
  reviews?: unknown;
  [key: string]: unknown;
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

function extractReviews(value: unknown): SchemaReview[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractReviews(item));

  const block = value as SchemaOrgBlock;
  const reviews: SchemaReview[] = [];

  if (typeIncludes(block["@type"], "Review")) {
    reviews.push(block as SchemaReview);
  }

  reviews.push(...extractReviews(block["@graph"]));
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

async function externalIdForReview(reviewUrl: string | null, body: string, authorName: string | null): Promise<string> {
  if (reviewUrl) return sha256Hex(`trustpilot:${reviewUrl}`);
  return sha256Hex(`trustpilot:${body.trim().replace(/\s+/g, " ")}:${authorName?.trim() ?? ""}`);
}

export async function scrapeTrustpilot(
  businessUnitId: string,
  page = 1,
): Promise<ConnectorResult[]> {
  const url = `https://www.trustpilot.com/review/${businessUnitId}?page=${page}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  }).catch((cause) => {
    throw new Error("scrape-trustpilot: fetch failed", { cause });
  });

  if (!res.ok) {
    throw new Error(`scrape-trustpilot: HTTP ${res.status}`);
  }

  const html = await readResponseTextBounded(res, "scrape-trustpilot");

  // Extract all <script type="application/ld+json"> blocks
  const ldJsonMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  const now = nowIso();
  const results: ConnectorResult[] = [];

  for (const match of ldJsonMatches) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }

    const reviews = extractReviews(parsed);
    for (const r of reviews) {
      const body = r.reviewBody ?? r.description ?? "";
      if (!body) continue;

      const authorName =
        typeof r.author === "string"
          ? r.author
          : r.author?.name ?? null;

      const ratingRaw = r.reviewRating?.ratingValue;
      const rating =
        ratingRaw !== undefined
          ? parseFloat(String(ratingRaw))
          : null;
      const validRating =
        rating !== null && !isNaN(rating) && rating >= 1 && rating <= 5
          ? rating
          : null;

      const reviewUrl = canonicalReviewUrl(r.url, url);
      const external_id = await externalIdForReview(reviewUrl, body, authorName);

      results.push({
        external_id,
        source: "trustpilot",
        author_name: authorName,
        body,
        rating: validRating,
        source_url: reviewUrl ?? url,
        imported_at: now,
      });
    }
  }

  return results;
}

function parsePage(value: string | undefined): number {
  if (!value) return 1;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export const trustpilotScrapeConnector: Connector = {
  source: "trustpilot",

  async fetch(config: Record<string, string>): Promise<ConnectorResult[]> {
    const { business_unit_id, page } = config;
    if (!business_unit_id) {
      throw new Error("scrape-trustpilot: 'business_unit_id' is required");
    }
    return scrapeTrustpilot(business_unit_id, parsePage(page));
  },
};
