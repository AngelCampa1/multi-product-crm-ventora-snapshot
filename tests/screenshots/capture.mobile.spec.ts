/**
 * tests/screenshots/capture.mobile.spec.ts — 3 representative mobile shots,
 * run under the `mobile` Playwright project (iPhone 13 device descriptor).
 */

import { test } from "@playwright/test";
import { prepCapture, waitFontsLoaded, shotViewport } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("31 mobile dashboard overview", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("heading", { name: "Overview" }).waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "31-mobile-dashboard-overview");
});

test("32 mobile customers list", async ({ page }) => {
  await page.goto("/customers");
  await page.getByText("Acme Corporation").first().waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "32-mobile-customers-list");
});

test("33 mobile wall of fame approved", async ({ page }) => {
  await page.goto("/wall?status=approved");
  await page.getByText("Camaudit found a six-figure").waitFor();
  await waitFontsLoaded(page);
  await prepCapture(page);
  await shotViewport(page, "33-mobile-wall-approved");
});
