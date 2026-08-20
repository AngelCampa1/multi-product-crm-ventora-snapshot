import { describe, expect, it } from "vitest";
import { escapeHtml, renderStars, renderStarSpans } from "../../src/widgets/render-utils";

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("a < b")).toBe("a &lt; b");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quote", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes single quote", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes all five entities in one string", () => {
    expect(escapeHtml(`<div class="a" data-x='b'>x & y</div>`)).toBe(
      "&lt;div class=&quot;a&quot; data-x=&#39;b&#39;&gt;x &amp; y&lt;/div&gt;",
    );
  });
});

describe("renderStars", () => {
  it("rating 5 → all five filled stars, no empty or half", () => {
    const html = renderStars(5);
    expect(html).toContain('<div class="stars">');
    const spans = html.match(/<span class="([^"]+)">([^<]+)<\/span>/g) ?? [];
    expect(spans).toHaveLength(5);
    for (const span of spans) {
      expect(span).toContain("star filled");
      expect(span).toContain("★");
    }
  });

  it("rating 0 → all five empty stars", () => {
    const html = renderStars(0);
    const spans = html.match(/<span class="([^"]+)">([^<]+)<\/span>/g) ?? [];
    expect(spans).toHaveLength(5);
    for (const span of spans) {
      expect(span).not.toContain("filled");
      expect(span).not.toContain("half");
      expect(span).toContain("☆");
    }
  });

  it("integer rating 3 → 3 filled, 2 empty, no half", () => {
    const spans = (renderStars(3).match(/<span class="([^"]+)">([^<]+)<\/span>/g) ?? []) as string[];
    const filled = spans.filter((s) => s.includes("filled"));
    const half = spans.filter((s) => s.includes("half"));
    const empty = spans.filter((s) => !s.includes("filled") && !s.includes("half"));
    expect(filled).toHaveLength(3);
    expect(half).toHaveLength(0);
    expect(empty).toHaveLength(2);
  });

  it("fractional rating 3.5 → 3 filled + 1 half + 1 empty", () => {
    const spans = (renderStars(3.5).match(/<span class="([^"]+)">([^<]+)<\/span>/g) ?? []) as string[];
    const filled = spans.filter((s) => s.includes("filled"));
    const half = spans.filter((s) => s.includes("half"));
    const empty = spans.filter((s) => !s.includes("filled") && !s.includes("half"));
    expect(filled).toHaveLength(3);
    expect(half).toHaveLength(1);
    expect(empty).toHaveLength(1);
  });

  it("wraps output in <div class=\"stars\">", () => {
    const html = renderStars(4);
    expect(html).toMatch(/^<div class="stars">.*<\/div>$/);
  });
});

describe("renderStarSpans (inner spans only)", () => {
  it("returns 5 spans with no wrapping div", () => {
    const html = renderStarSpans(2.5);
    expect(html).not.toContain("<div");
    const spans = html.match(/<span/g) ?? [];
    expect(spans).toHaveLength(5);
  });
});
