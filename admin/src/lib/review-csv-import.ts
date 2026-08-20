export type ReviewCsvField = "author_name" | "body" | "rating" | "source_url";

export type ReviewCsvMapping = Partial<Record<ReviewCsvField, string>>;

export interface ParsedReviewCsv {
  headers: string[];
  rows: string[][];
}

const NORMALIZED_HEADERS: ReviewCsvField[] = ["author_name", "body", "rating", "source_url"];

const FIELD_ALIASES: Record<ReviewCsvField, string[]> = {
  author_name: ["author_name", "author", "name", "reviewer", "reviewer_name", "customer_name"],
  body: ["body", "review", "review_text", "comment", "comments", "testimonial", "text"],
  rating: ["rating", "stars", "star_rating", "score"],
  source_url: ["source_url", "url", "link", "review_url", "source_link"],
};

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }

  row.push(cell.trim());
  rows.push(row);

  return rows.filter((fields) => fields.some((field) => field.trim().length > 0));
}

export function parseReviewCsvForMapping(text: string): ParsedReviewCsv {
  const rows = parseCsv(text);
  const headers = rows[0] ?? [];

  return {
    headers,
    rows: rows.slice(1),
  };
}

export function inferReviewCsvMapping(headers: string[]): ReviewCsvMapping {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const mapping: ReviewCsvMapping = {};

  for (const field of NORMALIZED_HEADERS) {
    const match = FIELD_ALIASES[field].find((alias) => normalizedHeaders.has(alias));
    if (match) {
      mapping[field] = normalizedHeaders.get(match);
    }
  }

  return mapping;
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildHeaderIndex(headers: string[]): Map<string, number> {
  return new Map(headers.map((header, index) => [header, index]));
}

export function buildNormalizedReviewCsv(parsed: ParsedReviewCsv, mapping: ReviewCsvMapping): string {
  if (!mapping.body) {
    throw new Error("Review text column is required");
  }

  const headerIndex = buildHeaderIndex(parsed.headers);
  const bodyIndex = headerIndex.get(mapping.body);
  if (bodyIndex === undefined) {
    throw new Error("Review text column is required");
  }

  const mappedIndexes = NORMALIZED_HEADERS.map((field) => {
    const header = mapping[field];
    return header ? headerIndex.get(header) : undefined;
  });

  const normalizedRows = parsed.rows
    .filter((row) => (row[bodyIndex] ?? "").trim().length > 0)
    .map((row) =>
      mappedIndexes
        .map((index) => (index === undefined ? "" : (row[index] ?? "").trim()))
        .map(escapeCsvCell)
        .join(","),
    );

  return [NORMALIZED_HEADERS.join(","), ...normalizedRows].join("\n");
}
