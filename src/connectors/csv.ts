import { nowIso } from "../db/queries";
import { sha256Hex } from "./base";
import type { Connector, ConnectorResult } from "./base";

// ---------------------------------------------------------------------------
// CSV parsing — no external library; handles quoted fields and escaped quotes.
// Expected header: author_name, body, rating, source_url (all optional except body).
// ---------------------------------------------------------------------------

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let current = "";
  let inQuotes = false;

  function pushCell() {
    row.push(current.trim());
    current = "";
  }

  function pushRow() {
    if (row.some((field) => field.trim().length > 0)) {
      records.push(row);
    }
    row = [];
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ("")
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '"';
          i++; // skip next quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        pushCell();
      } else if (ch === "\n") {
        pushCell();
        pushRow();
      } else if (ch === "\r") {
        if (text[i + 1] === "\n") {
          continue;
        }
        pushCell();
        pushRow();
      } else {
        current += ch;
      }
    }
  }

  pushCell();
  pushRow();
  return records;
}

export async function parseCSV(text: string): Promise<ConnectorResult[]> {
  const records = parseCsvRecords(text);

  if (records.length < 2) {
    // Header-only or empty
    return [];
  }

  const headers = (records[0] ?? []).map((h) =>
    h.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z_]/g, ""),
  );

  const authorIdx = headers.indexOf("author_name");
  const bodyIdx = headers.indexOf("body");
  const ratingIdx = headers.indexOf("rating");
  const urlIdx = headers.indexOf("source_url");

  const results: ConnectorResult[] = [];
  const now = nowIso();

  for (let i = 1; i < records.length; i++) {
    const row = records[i] ?? [];

    const bodyCell = bodyIdx >= 0 ? (row[bodyIdx] ?? "") : "";
    const body = bodyCell.trim();
    if (!body) continue; // skip rows without body

    const authorCell = authorIdx >= 0 ? (row[authorIdx] ?? "") : "";
    const author_name = authorCell.trim() || null;
    const ratingCell = ratingIdx >= 0 ? (row[ratingIdx] ?? "") : "";
    const ratingRaw = ratingCell ? parseFloat(ratingCell) : NaN;
    const rating = !isNaN(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;
    const urlCell = urlIdx >= 0 ? (row[urlIdx] ?? "") : "";
    const source_url = urlCell.trim() || null;

    const external_id = await sha256Hex([
      body.toLowerCase().replace(/\s+/g, " ").trim(),
      author_name?.toLowerCase().replace(/\s+/g, " ").trim() ?? "",
      source_url ?? "",
    ].join("|"));

    results.push({
      external_id,
      source: "csv",
      author_name,
      body,
      rating,
      source_url,
      imported_at: now,
    });
  }

  return results;
}

export const csvConnector: Connector = {
  source: "csv",

  async fetch(config: Record<string, string>): Promise<ConnectorResult[]> {
    const { csv_text } = config;
    if (!csv_text) {
      throw new Error("csv connector: 'csv_text' is required");
    }
    return parseCSV(csv_text);
  },
};
