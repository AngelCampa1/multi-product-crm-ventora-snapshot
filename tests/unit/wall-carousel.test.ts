import { describe, it, expect } from "vitest";
import { renderWallCarousel, type WallCarouselTestimonial } from "../../src/widgets/wall-carousel";

function makeTestimonial(quote: string): WallCarouselTestimonial {
  return {
    quote,
    customer_name: "Maria Chen",
    customer_role: "VP Operations",
    customer_company: "Northwind REIT",
    rating: 5,
    source: "manual",
  };
}

describe("renderWallCarousel", () => {
  it("renders nothing when there are no approved testimonials", () => {
    const { html, css } = renderWallCarousel({ testimonials: [] });
    expect(html).toBe("");
    expect(css).toBe("");
  });

  it("doubles the cards for a seamless loop but hides the duplicate set from assistive tech", () => {
    const { html } = renderWallCarousel({
      testimonials: [makeTestimonial("Great product"), makeTestimonial("Loved it")],
    });
    // Two real cards + two aria-hidden clones = four cards total, but only the
    // clones carry aria-hidden so each quote is announced exactly once.
    const cardCount = html.match(/class="card"/g)?.length ?? 0;
    const hiddenCount = html.match(/aria-hidden="true"/g)?.length ?? 0;
    expect(cardCount).toBe(4);
    expect(hiddenCount).toBe(2);
  });

  it("exposes the strip as a labelled group", () => {
    const { html } = renderWallCarousel({ testimonials: [makeTestimonial("Great")] });
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Customer testimonials"');
  });

  it("can be paused and respects reduced-motion (WCAG 2.2.2 / 2.3.3)", () => {
    const { css } = renderWallCarousel({ testimonials: [makeTestimonial("Great")] });
    // The marquee must stop on hover/focus and honour prefers-reduced-motion,
    // otherwise it is an auto-moving region a user cannot pause.
    expect(css).toContain("animation-play-state: paused");
    expect(css).toContain(":hover .track");
    expect(css).toContain(":focus-within .track");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none");
  });
});
