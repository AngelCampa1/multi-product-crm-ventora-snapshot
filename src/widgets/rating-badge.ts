import { escapeHtml, renderStarSpans } from "./render-utils";

export function renderRatingBadge(data: {
  average_rating: number;
  total_count: number;
  product_name: string;
}): { html: string; css: string } {
  if (data.total_count <= 0) {
    return { html: "", css: "" };
  }

  const avg = data.average_rating;
  const display = avg.toFixed(1);

  const reviewWord = data.total_count === 1 ? "review" : "reviews";
  const ariaLabel = `Rated ${display} out of 5 stars based on ${data.total_count} ${reviewWord}`;

  const html = `
    <div class="badge" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <div class="stars" aria-hidden="true">${renderStarSpans(avg)}</div>
      <div class="score" aria-hidden="true">${escapeHtml(display)} out of 5</div>
      <div class="count" aria-hidden="true">based on ${data.total_count} ${reviewWord}</div>
    </div>
  `;

  const css = `
    :host { display: inline-block; font-family: system-ui, sans-serif; }
    .badge {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 10px 16px;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.05);
    }
    .stars { display: flex; gap: 2px; }
    .star { font-size: 1.15rem; color: #d1d5db; }
    .star.filled { color: #f59e0b; }
    .star.half {
      color: #f59e0b;
      opacity: 0.55;
    }
    .score {
      font-size: 0.85rem;
      font-weight: 600;
      color: #111827;
    }
    .count {
      font-size: 0.72rem;
      color: #9ca3af;
    }
  `;

  return { html, css };
}

