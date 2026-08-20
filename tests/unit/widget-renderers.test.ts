import { describe, expect, it } from "vitest";
import { renderRatingBadge } from "../../src/widgets/rating-badge";
import { renderWallCarousel } from "../../src/widgets/wall-carousel";

describe("widget renderers", () => {
  it("does not render a misleading zero rating when no approved ratings exist", () => {
    const rendered = renderRatingBadge({
      average_rating: 0,
      total_count: 0,
      product_name: "CAMAudit",
    });

    // An empty badge renders nothing on the host page rather than a placeholder —
    // crucially never a misleading "0.0 out of 5" / "based on 0 reviews".
    expect(rendered.html).toBe("");
    expect(rendered.html).not.toContain("0.0 out of 5");
    expect(rendered.html).not.toContain("based on 0 reviews");
  });

  it("uses an explicit empty carousel state without invalid negative width math", () => {
    const rendered = renderWallCarousel({ testimonials: [] });

    // No testimonials → render nothing (no track, no negative-width loop math).
    expect(rendered.html).toBe("");
    expect(rendered.css).not.toContain("* -1");
    expect(rendered.css).not.toContain("calc(-0px");
  });

  it("carousel end-translate equals N * 316px for a seamless loop", () => {
    const N = 3;
    const step = 316; // CARD(300) + GAP(16)
    const rendered = renderWallCarousel({
      testimonials: Array.from({ length: N }, (_, i) => ({
        quote: `Quote ${i}`,
        customer_name: `Name ${i}`,
        customer_role: null,
        customer_company: null,
        rating: null,
        source: "manual",
      })),
    });

    // The keyframe must translate by exactly -(N * step)px so the second copy
    // lands where the first began, producing a seamless infinite scroll.
    expect(rendered.css).toContain(`translateX(${-N * step}px)`);
  });

  it("carousel CSS contains a prefers-reduced-motion block that disables animation", () => {
    const rendered = renderWallCarousel({
      testimonials: [
        {
          quote: "Hello",
          customer_name: "Alice",
          customer_role: null,
          customer_company: null,
          rating: null,
          source: "manual",
        },
      ],
    });

    expect(rendered.css).toContain("prefers-reduced-motion");
    expect(rendered.css).toContain("animation: none");
  });
});
