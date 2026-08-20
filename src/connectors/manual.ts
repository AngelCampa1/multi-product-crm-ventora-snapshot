import { nowIso } from "../db/queries";
import { sha256Hex } from "./base";
import type { Connector, ConnectorResult } from "./base";

/**
 * Manual connector — creates a single review from user-supplied text.
 * external_id is a SHA-256 of (body + author_name) so the same content
 * submitted twice is deduplicated.
 */
export const manualConnector: Connector = {
  source: "manual",

  async fetch(config: Record<string, string>): Promise<ConnectorResult[]> {
    const { body, author_name, rating, source_url } = config;

    if (!body) {
      throw new Error("manual connector: 'body' is required");
    }

    const external_id = await sha256Hex(body + (author_name ?? ""));

    const ratingNum = rating ? parseFloat(rating) : null;
    const validRating =
      ratingNum !== null && !isNaN(ratingNum) && ratingNum >= 1 && ratingNum <= 5
        ? ratingNum
        : null;

    return [
      {
        external_id,
        source: "manual",
        author_name: author_name ?? null,
        body,
        rating: validRating,
        source_url: source_url ?? null,
        imported_at: nowIso(),
      },
    ];
  },
};
