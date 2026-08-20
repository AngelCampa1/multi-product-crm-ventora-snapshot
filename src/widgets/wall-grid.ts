import { escapeHtml, renderStars } from "./render-utils";

export interface WallGridTestimonial {
  quote: string;
  customer_name: string;
  customer_role: string | null;
  customer_company: string | null;
  rating: number | null;
  source: string;
}

function renderCard(t: WallGridTestimonial): string {
  const attribution = [t.customer_name, t.customer_role, t.customer_company]
    .filter(Boolean)
    .join(" · ");
  return `
    <div class="card">
      <div class="quote-text">${escapeHtml(t.quote)}</div>
      ${t.rating !== null ? renderStars(t.rating) : ""}
      <div class="footer">
        <span class="attribution">${escapeHtml(attribution)}</span>
        <span class="source-badge">${escapeHtml(t.source)}</span>
      </div>
    </div>
  `;
}

export function renderWallGrid(data: { testimonials: WallGridTestimonial[] }): {
  html: string;
  css: string;
} {
  // No approved testimonials → render nothing so the widget silently
  // disappears on the host site (and surfaces the "empty" hint in preview).
  if (data.testimonials.length === 0) {
    return { html: "", css: "" };
  }

  const html = `<div class="grid">${data.testimonials.map(renderCard).join("")}</div>`;
  const css = `
    :host { display: block; font-family: system-ui, sans-serif; }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      padding: 16px;
    }
    @media (max-width: 640px) {
      .grid { grid-template-columns: 1fr; }
    }
    .card {
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.04);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .quote-text {
      font-size: 0.95rem;
      line-height: 1.55;
      color: #1a1a1a;
      flex: 1;
    }
    .stars { display: flex; gap: 2px; }
    .star { font-size: 1rem; color: #d1d5db; }
    .star.filled { color: #f59e0b; }
    .star.half { color: #f59e0b; opacity: 0.55; }
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .attribution {
      font-size: 0.8rem;
      color: #6b7280;
      font-weight: 500;
    }
    .source-badge {
      font-size: 0.7rem;
      background: #f3f4f6;
      color: #374151;
      border-radius: 4px;
      padding: 2px 7px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
  `;
  return { html, css };
}
