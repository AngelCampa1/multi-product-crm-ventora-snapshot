import { describe, it, expect } from "vitest";
import { renderWallGrid } from "../../src/widgets/wall-grid";
import { renderWallCarousel } from "../../src/widgets/wall-carousel";
import { renderSingleQuote } from "../../src/widgets/single-quote";

// Every content widget shares one rule: with no approved content, render
// nothing so it silently disappears on a customer site rather than showing an
// empty shell. The preview sandbox detects the empty render and shows a hint.

describe("widget empty states", () => {
  it("wall-grid renders nothing with no testimonials", () => {
    expect(renderWallGrid({ testimonials: [] })).toEqual({ html: "", css: "" });
  });

  it("wall-carousel renders nothing with no testimonials", () => {
    expect(renderWallCarousel({ testimonials: [] })).toEqual({ html: "", css: "" });
  });

  it("single-quote renders nothing with no testimonial", () => {
    expect(renderSingleQuote({ testimonial: null })).toEqual({ html: "", css: "" });
  });

  it("wall-grid renders cards once testimonials exist", () => {
    const { html } = renderWallGrid({
      testimonials: [
        {
          quote: "It just works.",
          customer_name: "Dana Whitfield",
          customer_role: "Ops Lead",
          customer_company: "Acme",
          rating: 5,
          source: "manual",
        },
      ],
    });
    expect(html).toContain("It just works.");
    expect(html).toContain("grid");
  });
});
