/**
 * tests/screenshots/fixtures.ts
 *
 * Shared helpers for the deterministic screenshot captures in capture.spec.ts
 * and capture.mobile.spec.ts. No `waitForTimeout` anywhere — every wait here
 * is a concrete condition (a locator, a font-load flag, a DOM probe).
 */

import type { Locator, Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export const SCREENSHOTS_DIR = join(process.cwd(), "docs", "screenshots");
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

/** Captures that would render taller than this (in CSS px) are saved as JPEG q82 instead of PNG. */
const JPEG_HEIGHT_THRESHOLD = 1400;

// ---------------------------------------------------------------------------
// Determinism + branding injected before every capture
// ---------------------------------------------------------------------------

export async function injectDeterminism(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      html { scrollbar-width: none !important; }
    `,
  });
}

const DEMO_BANNER_HEIGHT_PX = 32;

/**
 * Stamps the "this is fake data" bar across the top of every capture.
 *
 * The bar is fixed to the viewport, so on its own it would sit *over* the app's
 * own header — clipping the sidebar brand and the page <h1> in every shot. To
 * avoid that, body gets a matching translateY: a transform on body establishes
 * a containing block for its `position: fixed` descendants (the sidebar, modal
 * drawers), so the whole app shifts down together and nothing is occluded. The
 * bar itself is appended to <html>, outside that containing block, so it stays
 * pinned at the very top.
 */
export async function injectDemoBanner(page: Page): Promise<void> {
  await page.evaluate((height: number) => {
    if (document.getElementById("__vt_demo_banner__")) return;
    const bar = document.createElement("div");
    bar.id = "__vt_demo_banner__";
    // The full sentence doesn't fit a phone viewport — left to wrap it spills out
    // of the 32px bar and lands on top of the page content underneath.
    bar.textContent =
      window.innerWidth < 768
        ? "DEMO DATA — not real customers"
        : "DEMO DATA — fictional companies, local database, not real customers";
    Object.assign(bar.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      height: `${height}px`,
      zIndex: "2147483647",
      background: "#f59e0b",
      color: "#1c1300",
      font: `600 12px/${height}px system-ui, sans-serif`,
      textAlign: "center",
      pointerEvents: "none",
      letterSpacing: "0.02em",
      whiteSpace: "nowrap",
      overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>);
    document.documentElement.appendChild(bar);

    document.body.style.transform = `translateY(${height}px)`;
    document.body.style.transformOrigin = "top left";
  }, DEMO_BANNER_HEIGHT_PX);
}

/** Standard pre-capture prep: determinism CSS + demo banner. Call after the page has settled. */
export async function prepCapture(page: Page): Promise<void> {
  await injectDeterminism(page);
  await injectDemoBanner(page);
}

export async function waitFontsLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => document.fonts.status === "loaded");
}

// ---------------------------------------------------------------------------
// Widget preview probes — mirror src/routes/preview/index.ts's own JS exactly
// instead of racing its ~1.8s polling timer.
// ---------------------------------------------------------------------------

export async function waitWidgetHasContent(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const stage = document.querySelector(".stage");
    const mount = stage?.querySelector(".mount");
    if (!stage || !mount) return false;
    const host = mount.querySelector("*");
    if (!host) return false;
    const root = (host as HTMLElement).shadowRoot;
    if (!root) return (mount as HTMLElement).offsetHeight > 40;
    const nodes = root.querySelectorAll("*:not(style):not(script)");
    for (const node of Array.from(nodes)) {
      if (node.tagName === "IMG") return true;
      if (node.children.length === 0 && (node.textContent ?? "").trim().length > 0) return true;
    }
    return false;
  });
}

/**
 * Scrolls `locator` to the top of the viewport so the section below it fills the
 * frame. Playwright's scrollIntoViewIfNeeded is a no-op once an element is
 * on-screen at all, which for a long page means the shot ends up framed on
 * whatever happened to be above the section we actually want to show.
 */
export async function scrollSectionToTop(locator: Locator): Promise<void> {
  await locator.evaluate((el: HTMLElement) => el.scrollIntoView({ block: "start", behavior: "instant" }));
}

/** For the deliberate empty-state fixture (/preview/floriva-web/*): positively await the reveal. */
export async function waitWidgetEmpty(page: Page): Promise<void> {
  await page.locator("#vt-empty.show").waitFor({ state: "visible" });
}

// ---------------------------------------------------------------------------
// Screenshot writers — PNG by default; JPEG q82 once a capture would exceed
// the CSS-px height budget, to stay inside the repo size budget.
// ---------------------------------------------------------------------------

function pathFor(name: string, useJpeg: boolean): string {
  return join(SCREENSHOTS_DIR, `${name}.${useJpeg ? "jpg" : "png"}`);
}

/** Viewport-only screenshot (no scrolling) — the default capture mode. */
export async function shotViewport(page: Page, name: string): Promise<void> {
  const vp = page.viewportSize();
  const height = vp?.height ?? 900;
  const useJpeg = height > JPEG_HEIGHT_THRESHOLD;
  await page.screenshot(
    useJpeg
      ? { path: pathFor(name, true), type: "jpeg", quality: 82 }
      : { path: pathFor(name, false), type: "png" },
  );
}

/** Full-page screenshot — only for shots where the scroll tail carries real information. */
export async function shotFullPage(page: Page, name: string): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const useJpeg = height > JPEG_HEIGHT_THRESHOLD;
  await page.screenshot(
    useJpeg
      ? { path: pathFor(name, true), type: "jpeg", quality: 82, fullPage: true }
      : { path: pathFor(name, false), type: "png", fullPage: true },
  );
}

/**
 * Element-clipped screenshot — for panels/drawers/modals.
 *
 * The page-level banner is fixed to the viewport, so on an element clip it
 * lands on top of whatever the element renders in its own first 32px (a drawer
 * header, typically). For these captures we hide it and splice an equivalent
 * banner into the element's own flow instead, so the label is still present in
 * the image but occludes nothing.
 */
export async function shotElement(locator: Locator, name: string): Promise<void> {
  await locator.evaluate((el: HTMLElement, height: number) => {
    const fixed = document.getElementById("__vt_demo_banner__");
    if (fixed) fixed.style.display = "none";
    document.body.style.transform = "";

    if (el.querySelector("#__vt_demo_banner_inline__")) return;
    const bar = document.createElement("div");
    bar.id = "__vt_demo_banner_inline__";
    // Shorter than the page-level wording on purpose: a clipped element can be
    // as narrow as a confirm dialog, where the full sentence wraps to three
    // lines and takes up more of the image than the UI being documented.
    bar.textContent = "DEMO DATA — not real customers";
    Object.assign(bar.style, {
      flex: "0 0 auto",
      background: "#f59e0b",
      color: "#1c1300",
      font: `600 11px/${height}px system-ui, sans-serif`,
      textAlign: "center",
      letterSpacing: "0.02em",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);
    el.insertBefore(bar, el.firstChild);
  }, DEMO_BANNER_HEIGHT_PX);

  const box = await locator.boundingBox();
  const height = box?.height ?? 900;
  const useJpeg = height > JPEG_HEIGHT_THRESHOLD;
  await locator.screenshot(
    useJpeg
      ? { path: pathFor(name, true), type: "jpeg", quality: 82 }
      : { path: pathFor(name, false), type: "png" },
  );
}

// ---------------------------------------------------------------------------
// CSV upload fixture — non-canonical headers, reached via a real file input
// (typing into the textarea clears the header-mapping UI, per admin/src/pages/Reviews.tsx).
// ---------------------------------------------------------------------------

export function writeNonCanonicalReviewCsv(): string {
  const csv = [
    "Reviewer,Comments,Stars,Link",
    'Priya N.,"Camaudit caught a CAM overcharge we would have missed.",5,https://example.com/review/1',
    'Marcus W.,"Great detection rules, onboarding could be a bit faster.",4,https://example.com/review/2',
  ].join("\n");
  const path = join(tmpdir(), "ventora-demo-review-import.csv");
  writeFileSync(path, csv, "utf-8");
  return path;
}
