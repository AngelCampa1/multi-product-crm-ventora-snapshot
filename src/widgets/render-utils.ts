export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders 5 star spans using half-star semantics.
 * For each position i (1..5): diff = rating - (i-1).
 *   diff >= 1  → filled star
 *   0 < diff < 1 → half star
 *   diff <= 0  → empty star
 *
 * Returns the inner <span> markup only (no wrapper div).
 * Callers wrap as needed (e.g. <div class="stars">…</div>).
 */
export function renderStarSpans(rating: number): string {
  const stars: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const diff = rating - (i - 1);
    let cls = "star";
    let char: string;
    if (diff >= 1) {
      cls += " filled";
      char = "★";
    } else if (diff > 0) {
      cls += " half";
      char = "★";
    } else {
      char = "☆";
    }
    stars.push(`<span class="${cls}">${char}</span>`);
  }
  return stars.join("");
}

/**
 * Renders a full <div class="stars">…</div> block using half-star semantics.
 * Used by wall-grid and wall-carousel.
 */
export function renderStars(rating: number): string {
  return `<div class="stars">${renderStarSpans(rating)}</div>`;
}
