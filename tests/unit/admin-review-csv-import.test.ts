import { describe, expect, it } from "vitest";
import {
  buildNormalizedReviewCsv,
  inferReviewCsvMapping,
  parseReviewCsvForMapping,
  type ReviewCsvMapping,
} from "../../admin/src/lib/review-csv-import";
import { parseCSV } from "../../src/connectors/csv";

describe("admin review CSV import mapping", () => {
  it("parses uploaded CSV headers and rows with quoted commas", () => {
    const parsed = parseReviewCsvForMapping(
      'Reviewer,Review,Stars,Link\n"Jane, VP","Great, fast setup",5,https://example.com',
    );

    expect(parsed.headers).toEqual(["Reviewer", "Review", "Stars", "Link"]);
    expect(parsed.rows).toEqual([
      ["Jane, VP", "Great, fast setup", "5", "https://example.com"],
    ]);
  });

  it("infers likely mapping from common review export header names", () => {
    const parsed = parseReviewCsvForMapping(
      "Reviewer Name,Review Text,Score,Review URL\nJane Doe,Useful,4,https://example.com",
    );

    expect(inferReviewCsvMapping(parsed.headers)).toEqual({
      author_name: "Reviewer Name",
      body: "Review Text",
      rating: "Score",
      source_url: "Review URL",
    });
  });

  it("builds normalized CSV text for the existing csv_text endpoint", () => {
    const parsed = parseReviewCsvForMapping(
      'Name,Comment,Rating,URL\nJane,"Great product",5,https://example.com\nSam,"Includes ""quotes""",,',
    );
    const mapping: ReviewCsvMapping = {
      author_name: "Name",
      body: "Comment",
      rating: "Rating",
      source_url: "URL",
    };

    expect(buildNormalizedReviewCsv(parsed, mapping)).toBe(
      'author_name,body,rating,source_url\nJane,Great product,5,https://example.com\nSam,"Includes ""quotes""",,',
    );
  });

  it("requires a mapped body column", () => {
    const parsed = parseReviewCsvForMapping("Name,Comment\nJane,Great");

    expect(() => buildNormalizedReviewCsv(parsed, { body: "" })).toThrow("Review text column is required");
  });

  it("round-trips multiline review bodies through the server CSV parser", async () => {
    const parsed = parseReviewCsvForMapping('Name,Review\nJane,"Line one\nLine two"');
    const normalized = buildNormalizedReviewCsv(parsed, {
      author_name: "Name",
      body: "Review",
    });

    await expect(parseCSV(normalized)).resolves.toEqual([
      expect.objectContaining({
        author_name: "Jane",
        body: "Line one\nLine two",
      }),
    ]);
  });

  it("derives stable CSV review ids when rows are reordered", async () => {
    const first = await parseCSV([
      "author_name,body,rating,source_url",
      "Jane,First review,5,https://example.test/reviews/1",
      "Sam,Second review,4,https://example.test/reviews/2",
    ].join("\n"));
    const reordered = await parseCSV([
      "author_name,body,rating,source_url",
      "Sam,Second review,4,https://example.test/reviews/2",
      "Jane,First review,5,https://example.test/reviews/1",
    ].join("\n"));

    expect(reordered.find((review) => review.body === "First review")?.external_id).toBe(
      first.find((review) => review.body === "First review")?.external_id,
    );
    expect(reordered.find((review) => review.body === "Second review")?.external_id).toBe(
      first.find((review) => review.body === "Second review")?.external_id,
    );
  });
});
