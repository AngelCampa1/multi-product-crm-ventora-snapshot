import { escapeHtml } from "./render-utils";

export interface SingleQuoteTestimonial {
  quote: string;
  customer_name: string;
  customer_role: string | null;
  customer_company: string | null;
  rating: number | null;
  source: string;
}

export function renderSingleQuote(data: { testimonial: SingleQuoteTestimonial | null }): {
  html: string;
  css: string;
} {
  if (!data.testimonial) {
    return { html: "", css: "" };
  }

  const t = data.testimonial;
  const attribution = [t.customer_name, t.customer_role, t.customer_company]
    .filter(Boolean)
    .join(" · ");

  const html = `
    <div class="wrapper">
      <div class="quote-mark" aria-hidden="true">&ldquo;</div>
      <blockquote class="quote-text">${escapeHtml(t.quote)}</blockquote>
      <div class="attribution">${escapeHtml(attribution)}</div>
    </div>
  `;

  const css = `
    :host { display: block; font-family: system-ui, sans-serif; }
    .wrapper {
      position: relative;
      max-width: 720px;
      margin: 0 auto;
      padding: 32px 40px;
      text-align: center;
    }
    .quote-mark {
      font-size: 6rem;
      line-height: 0;
      color: #e5e7eb;
      position: absolute;
      top: 48px;
      left: 24px;
      font-family: Georgia, serif;
      pointer-events: none;
    }
    .quote-text {
      font-size: 1.35rem;
      font-weight: 600;
      line-height: 1.5;
      color: #111827;
      margin: 0 0 20px;
      position: relative;
    }
    .attribution {
      font-size: 0.875rem;
      color: #6b7280;
    }
  `;

  return { html, css };
}
