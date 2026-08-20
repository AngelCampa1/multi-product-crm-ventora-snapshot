import type { D1Database } from "@cloudflare/workers-types";
import { ReviewsDB } from "../db/queries";
import type { Review } from "../db/queries";

// ---------------------------------------------------------------------------
// ConnectorResult — the shape every connector returns.
// ---------------------------------------------------------------------------

export interface ConnectorResult {
  external_id: string;
  source: Review["source"];
  author_name: string | null;
  body: string;
  rating: number | null;
  source_url: string | null;
  imported_at: string;
}

// ---------------------------------------------------------------------------
// Connector interface — implement one per source.
// ---------------------------------------------------------------------------

export interface Connector {
  source: Review["source"];
  fetch(config: Record<string, string>): Promise<ConnectorResult[]>;
}

// ---------------------------------------------------------------------------
// SHA-256 helper — works in Workers (crypto.subtle) and Node (globalThis.crypto).
// ---------------------------------------------------------------------------

export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function readResponseTextBounded(
  response: Response,
  label: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`${label}: response exceeds ${maxBytes} byte limit`);
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reading = true;
  while (reading) {
    const result = await reader.read();
    if (result.done) {
      reading = false;
      continue;
    }
    const value = result.value;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label}: response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// dedupAndSave — inserts new results; tracks inserted, skipped, and failed rows.
//
// Strategy: check whether the row exists BEFORE upsert.  ReviewsDB.upsert
// uses ON CONFLICT … DO UPDATE, so it always "succeeds" — we need the
// pre-flight check to distinguish insert from update/skip.
// ---------------------------------------------------------------------------

export async function dedupAndSave(
  db: D1Database,
  product_id: string,
  results: ConnectorResult[],
): Promise<{
  inserted: number;
  updated: number;
  skipped: number;
  errors: { source: Review["source"]; external_id: string; error: string }[];
}> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: { source: Review["source"]; external_id: string; error: string }[] = [];

  for (const r of results) {
    const existing = await ReviewsDB.getByProductSourceAndExternalId(db, product_id, r.source, r.external_id);

    if (existing && !reviewPayloadChanged(existing, r, product_id)) {
      skipped++;
      continue;
    }

    try {
      await ReviewsDB.upsert(db, {
        customer_id: null,
        product_id,
        source: r.source,
        external_id: r.external_id,
        rating: r.rating,
        body: r.body,
        author_name: r.author_name,
        source_url: r.source_url,
      });

      if (existing) {
        updated++;
      } else {
        inserted++;
      }
    } catch (err) {
      errors.push({
        source: r.source,
        external_id: r.external_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { inserted, updated, skipped, errors };
}

function reviewPayloadChanged(existing: Review, next: ConnectorResult, productId: string): boolean {
  return (
    existing.rating !== next.rating ||
    existing.body !== next.body ||
    existing.author_name !== next.author_name ||
    existing.source_url !== next.source_url ||
    existing.product_id !== productId
  );
}
