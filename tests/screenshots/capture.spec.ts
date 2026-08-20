/**
 * tests/screenshots/capture.spec.ts — desktop screenshot captures.
 *
 * Runs against the demo worker started by scripts/demo-shots.ts (baseURL
 * from playwright.screenshots.config.ts). Each shot is its own `test()` so a
 * failure in one doesn't take out the rest of the set. No `waitForTimeout`
 * anywhere — every wait below is a concrete locator/condition.
 */

import { test, expect } from "@playwright/test";
import {
  prepCapture,
  waitFontsLoaded,
  waitWidgetHasContent,
  waitWidgetEmpty,
  scrollSectionToTop,
  shotViewport,
  shotElement,
  writeNonCanonicalReviewCsv,
} from "./fixtures";

// Deliberately NOT `mode: "serial"`. playwright.screenshots.config.ts already
// pins workers:1 + fullyParallel:false, so these run one at a time regardless —
// and serial mode would additionally skip every remaining shot after the first
// failure, which is the opposite of what we want from a capture run.

// ---------------------------------------------------------------------------
// 01-02 — Dashboard
// ---------------------------------------------------------------------------

test("01 dashboard overview", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("heading", { name: "Overview" }).waitFor();
  await expect(page.getByText("Product readiness")).toBeVisible();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "01-dashboard-overview");
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

test("02 customers list", async ({ page }) => {
  await page.goto("/customers");
  await page.getByText("Acme Corporation").first().waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "02-customers-list");
});

test("03 customer detail drawer + 04 activity timeline", async ({ page }) => {
  await page.goto("/customers");
  await page.getByText("Acme Corporation").first().waitFor();
  await page.getByRole("button", { name: /View Priya Natarajan/i }).click();
  const drawer = page.getByRole("dialog", { name: /Customer detail: Priya Natarajan/i });
  await drawer.getByText("Activity Timeline").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotElement(drawer, "03-customer-detail-drawer");

  await drawer.getByText("Activity Timeline").scrollIntoViewIfNeeded();
  await shotElement(drawer, "04-customer-activity-timeline");
});

test("05 customers filtered by lifecycle", async ({ page }) => {
  await page.goto("/customers");
  await page.getByText("Acme Corporation").first().waitFor();
  await page.getByLabel("Filter by lifecycle stage").selectOption("champion");
  await expect(page.getByText(/^4 customers$/)).toBeVisible();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "05-customers-filtered");
});

test("06 add customer sheet", async ({ page }) => {
  await page.goto("/customers");
  await page.getByText("Acme Corporation").first().waitFor();
  await page.getByRole("button", { name: "Add Customer" }).click();
  const sheet = page.getByRole("dialog", { name: "Add Customer" });
  // The Name field's <label> isn't associated with its input (no htmlFor/id and
  // no aria-label), so getByLabel can't reach it — anchor on the placeholder.
  await sheet.getByPlaceholder("Jane Smith").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotElement(sheet, "06-add-customer-sheet");
});

// ---------------------------------------------------------------------------
// Wall of Fame
// ---------------------------------------------------------------------------

test("07 wall pending", async ({ page }) => {
  await page.goto("/wall?status=pending");
  await expect(page.getByRole("heading", { name: "Wall of Fame" })).toBeVisible();
  await page.getByText("Pending Approval").waitFor();
  await page.getByText("Our whole grants team moved off spreadsheets").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "07-wall-pending");
});

test("08 wall approved", async ({ page }) => {
  await page.goto("/wall?status=approved");
  await page.getByRole("button", { name: /^Approved/ }).click();
  await page.getByText("Camaudit found a six-figure").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "08-wall-approved");
});

test("09 testimonial edit drawer", async ({ page }) => {
  await page.goto("/wall?status=approved");
  await page.getByText("Camaudit found a six-figure").waitFor();
  await page.getByRole("button", { name: /View testimonial from Priya Natarajan/i }).click();
  const drawer = page.getByRole("dialog", { name: "Edit Testimonial" });
  await drawer.waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotElement(drawer, "09-testimonial-edit-drawer");
});

test("10 wall delete confirm", async ({ page }) => {
  await page.goto("/wall?status=approved");
  await page.getByText("Camaudit found a six-figure").waitFor();
  const card = page.getByRole("button", { name: /View testimonial from Priya Natarajan/i });
  await card.getByRole("button", { name: "Delete" }).click();
  await card.getByRole("button", { name: "Confirm delete" }).waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotElement(card, "10-wall-delete-confirm");
});

test("11 wall empty (floriva filter)", async ({ page }) => {
  await page.goto("/wall?status=approved");
  await page.getByText("Camaudit found a six-figure").waitFor();
  await page.getByLabel("Filter testimonials by product").selectOption({ label: "Floriva" });
  await page.getByText("No approved testimonials yet").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "11-wall-empty-floriva");
});

// ---------------------------------------------------------------------------
// Feedback kanban
// ---------------------------------------------------------------------------

// Width stays at the standard 1440. Widening it does NOT reveal more columns:
// admin/src/components/Layout.tsx caps the content well below that, and the
// board (Feedback.tsx, `overflow-x-auto`) scrolls inside that cap — so a wider
// viewport just pads the shot with empty background and leaves the last column
// clipped mid-canvas, which reads as broken rather than as a scroll affordance.
// Height is trimmed because the columns are much shorter than a full page.
const KANBAN_VIEWPORT = { width: 1440, height: 660 };

test("12 feedback kanban", async ({ page }) => {
  await page.setViewportSize(KANBAN_VIEWPORT);
  await page.goto("/feedback");
  await page.getByText("Bulk export of demand letters").waitFor();
  await expect(page.getByText("Declined")).toBeVisible();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "12-feedback-kanban");
});

test("13 feedback mid-drag", async ({ page }) => {
  await page.setViewportSize(KANBAN_VIEWPORT);
  await page.goto("/feedback");
  await page.getByText("Bulk export of demand letters").waitFor();
  const card = page.getByText("Bulk export of demand letters").first().locator("..");
  await card.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  // Mid-drag dnd-kit renders a DragOverlay clone, so this text now matches twice
  // (the source card and the floating overlay) — that duplication IS the shot.
  await page.getByText("Bulk export of demand letters").first().waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "13-feedback-mid-drag");
  // Cancel the drag so we don't leave the board mutated for later tests.
  await page.keyboard.press("Escape");
});

test("14 feedback detail drawer", async ({ page }) => {
  await page.goto("/feedback");
  await page.getByText("Bulk export of demand letters").waitFor();
  await page.getByText("Bulk export of demand letters").click();
  const drawer = page.getByRole("dialog", { name: "Feedback Detail" });
  await drawer.waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotElement(drawer, "14-feedback-detail-drawer");
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

test("15 reviews manual tab", async ({ page }) => {
  await page.goto("/reviews");
  await page.getByRole("heading", { name: "Reviews Import" }).waitFor();
  await page.getByLabel("Review text").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "15-reviews-manual-tab");
});

test("16 reviews CSV header-mapping panel", async ({ page }) => {
  await page.goto("/reviews");
  await page.getByRole("heading", { name: "Reviews Import" }).waitFor();
  await page.getByRole("button", { name: "CSV" }).click();
  const csvPath = writeNonCanonicalReviewCsv();
  await page.locator('input[type="file"][accept*="csv"]').setInputFiles(csvPath);
  // The mapping label renders the required marker inline, so its text node is
  // "Review Text *" — an exact match on "Review Text" never resolves.
  await page.getByText("Review Text *", { exact: true }).waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "16-reviews-csv-mapping");
});

test("17 reviews RSS tab", async ({ page }) => {
  await page.goto("/reviews");
  await page.getByRole("heading", { name: "Reviews Import" }).waitFor();
  await page.getByRole("button", { name: "RSS Feed" }).click();
  await page.locator("#rss-feed-url").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "17-reviews-rss-tab");
});

test("18 reviews connectors table", async ({ page }) => {
  await page.goto("/reviews");
  await page.getByRole("heading", { name: "Scheduled Connectors" }).waitFor();
  await page.getByText("ok", { exact: true }).waitFor();
  await page.getByText("error", { exact: true }).waitFor();
  await page.getByText("Not polled").waitFor();
  await scrollSectionToTop(page.getByRole("heading", { name: "Scheduled Connectors" }));
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "18-reviews-connectors-table");
});

test("19 imported reviews list", async ({ page }) => {
  await page.goto("/reviews");
  await page.getByRole("heading", { name: "Imported Reviews" }).waitFor();
  await page.getByText("Caught a duplicate CAM charge").waitFor();
  await scrollSectionToTop(page.getByRole("heading", { name: "Imported Reviews" }));
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "19-reviews-imported-list");
});

test("20 review delete confirm", async ({ page }) => {
  await page.goto("/reviews");
  await page.getByText("Caught a duplicate CAM charge").waitFor();
  const row = page.locator("tr", { hasText: "Caught a duplicate CAM charge" });
  await row.getByRole("button", { name: "Delete review" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete review" });
  await dialog.waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotElement(dialog, "20-review-delete-confirm");
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test("21 settings products", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  // Scoped to the table cell: a bare getByText("CAMAudit") also matches the
  // camaudit.io domain cell and the product <option> in the embed-code picker.
  await page.getByRole("cell", { name: "CAMAudit", exact: true }).waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "21-settings-products");
});

test("22 settings edit drawer", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("cell", { name: "CAMAudit", exact: true }).waitFor();
  const row = page.locator("tr", { hasText: "CAMAudit" });
  await row.getByRole("button", { name: "Edit" }).click();
  const drawer = page.getByRole("dialog", { name: "CAMAudit" });
  await drawer.getByText("Brand Color").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotElement(drawer, "22-settings-edit-drawer");
});

test("23 settings embed snippet", async ({ page }) => {
  await page.goto("/settings");
  await page.getByText("Embed Code").waitFor();
  await page.getByText("Embed Code").scrollIntoViewIfNeeded();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "23-settings-embed-snippet");
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

test("24 404 page", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await page.getByText("This page doesn’t exist").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "24-404-page");
});

// ---------------------------------------------------------------------------
// Widget previews
// ---------------------------------------------------------------------------

// feedback-button is captured separately below: at rest it renders only a
// floating launcher, so a plain viewport shot is an empty stage with a button in
// the corner. The modal behind that launcher is the part worth showing.
const WIDGETS = ["wall-grid", "wall-carousel", "single-quote", "rating-badge"] as const;
const WIDGET_SHOT_NUMBER: Record<(typeof WIDGETS)[number], string> = {
  "wall-grid": "25",
  "wall-carousel": "26",
  "single-quote": "27",
  "rating-badge": "28",
};

// Each widget is a different natural height, and the preview page doesn't shrink
// to fit — at a uniform 900px the small ones are two thirds empty background.
// Trim the viewport per widget so the shot is the widget, not the page under it.
const WIDGET_VIEWPORT_HEIGHT: Record<(typeof WIDGETS)[number], number> = {
  "wall-grid": 800,
  "wall-carousel": 480,
  "single-quote": 400,
  "rating-badge": 360,
};

for (const widget of WIDGETS) {
  test(`${WIDGET_SHOT_NUMBER[widget]} widget preview — ${widget}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: WIDGET_VIEWPORT_HEIGHT[widget] });
    await page.goto(`/preview/camaudit-v2/${widget}`);
    await waitWidgetHasContent(page);
    await waitFontsLoaded(page);
    await prepCapture(page);
    await shotViewport(page, `${WIDGET_SHOT_NUMBER[widget]}-widget-${widget}`);
  });
}

test("29 widget preview — feedback-button (modal open)", async ({ page }) => {
  await page.goto("/preview/camaudit-v2/feedback-button");
  await waitWidgetHasContent(page);
  // Playwright's CSS engine pierces open shadow roots, so the widget's internal
  // ids are reachable without hopping through the host element by hand.
  await page.locator("#vtFabBtn").click();
  await page.getByRole("dialog", { name: "Feedback" }).waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "29-widget-feedback-button");
});

test("30 widget empty state (floriva-web)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.goto("/preview/floriva-web/wall-grid");
  await waitWidgetEmpty(page);
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "30-widget-empty-floriva");
});
