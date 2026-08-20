import { describe, it, expect } from "vitest";
import { renderRatingBadge } from "../../src/widgets/rating-badge";

describe("renderRatingBadge", () => {
  it("renders nothing when there are zero approved ratings", () => {
    // A "0.0 out of 5 — based on 0 reviews" badge reads as a negative signal on
    // a customer site; the widget should silently disappear until there's proof.
    const { html, css } = renderRatingBadge({
      average_rating: 0,
      total_count: 0,
      product_name: "CAMAudit",
    });
    expect(html).toBe("");
    expect(css).toBe("");
  });

  it("renders the badge once there is at least one rating", () => {
    const { html } = renderRatingBadge({
      average_rating: 4.5,
      total_count: 12,
      product_name: "CAMAudit",
    });
    expect(html).toContain("4.5 out of 5");
    expect(html).toContain("based on 12 reviews");
    expect(html).toContain("★");
  });

  it("exposes a single screen-reader label and hides the decorative stars", () => {
    // Screen readers should hear one clean sentence, not a run of bare star
    // glyphs ("black star black star ...") followed by fragmented score text.
    const { html } = renderRatingBadge({
      average_rating: 4.5,
      total_count: 12,
      product_name: "CAMAudit",
    });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Rated 4.5 out of 5 stars based on 12 reviews"');
    expect(html).toContain('class="stars" aria-hidden="true"');
  });

  it("uses singular 'review' for a single rating", () => {
    const { html } = renderRatingBadge({
      average_rating: 5,
      total_count: 1,
      product_name: "CAMAudit",
    });
    expect(html).toContain("based on 1 review");
    expect(html).not.toContain("1 reviews");
  });
});
