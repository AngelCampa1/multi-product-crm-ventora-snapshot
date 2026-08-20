import { describe, expect, it } from "vitest";
import { renderFeedbackButton } from "../../src/widgets/feedback-button";

describe("renderFeedbackButton", () => {
  it("uses the product brand color for the button, focus, and submit styles", () => {
    const rendered = renderFeedbackButton({
      product_name: "GrantPipe",
      product_slug: "grantpipe",
      widget_public_key: "pk_test_123",
      brand_color: "#16A34A",
    });

    expect(rendered.css).toContain("background: #16a34a;");
    expect(rendered.css).toContain("border-color: #16a34a;");
    expect(rendered.css).toContain("rgba(22,163,74,0.4)");
  });

  it("ignores invalid brand colors and keeps the default indigo fallback", () => {
    const rendered = renderFeedbackButton({
      product_name: "CAMAudit",
      product_slug: "camaudit-v2",
      widget_public_key: "pk_test_123",
      brand_color: "blue",
    });

    expect(rendered.css).toContain("background: #4f46e5;");
    expect(rendered.css).not.toContain("background: blue;");
  });

  it("falls back to default indigo when brand_color is null", () => {
    const rendered = renderFeedbackButton({
      product_name: "CAMAudit",
      product_slug: "camaudit-v2",
      widget_public_key: "pk_test_123",
      brand_color: null,
    });

    expect(rendered.css).toContain("background: #4f46e5;");
    expect(rendered.html).toContain("Send Feedback");
  });
});
