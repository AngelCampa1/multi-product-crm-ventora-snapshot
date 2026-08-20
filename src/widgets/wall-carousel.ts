import { escapeHtml, renderStars } from "./render-utils";

export interface WallCarouselTestimonial {
  quote: string;
  customer_name: string;
  customer_role: string | null;
  customer_company: string | null;
  rating: number | null;
  source: string;
}

function renderCard(t: WallCarouselTestimonial, clone = false): string {
  const attribution = [t.customer_name, t.customer_role, t.customer_company]
    .filter(Boolean)
    .join(" · ");
  // The track holds two copies of the cards so the scroll loops seamlessly.
  // Hide the duplicate set from assistive tech so each quote is announced once.
  return `
    <div class="card"${clone ? ' aria-hidden="true"' : ""}>
      <div class="quote-text">${escapeHtml(t.quote)}</div>
      ${t.rating !== null ? renderStars(t.rating) : ""}
      <div class="footer">
        <span class="attribution">${escapeHtml(attribution)}</span>
        <span class="source-badge">${escapeHtml(t.source)}</span>
      </div>
    </div>
  `;
}

export function renderWallCarousel(data: { testimonials: WallCarouselTestimonial[] }): {
  html: string;
  css: string;
} {
  if (data.testimonials.length === 0) {
    return { html: "", css: "" };
  }

  const cards = data.testimonials.map((t) => renderCard(t)).join("");
  // The duplicate set carries aria-hidden so each quote is announced exactly once.
  const clones = data.testimonials.map((t) => renderCard(t, true)).join("");
  const doubled = cards + clones;
  // Seamless-loop invariant: the track holds 2N cards. The animation translates
  // exactly one full set width (N * step) to the left, placing the second copy
  // precisely where the first began. step = CARD + GAP = 316px.
  // Track width = 2N*CARD + (2N-1)*GAP  (2N cards, 2N-1 inter-card gaps).
  const N = data.testimonials.length;
  const CARD = 300;
  const GAP = 16;
  const step = CARD + GAP; // 316px per card slot

  const html = `
    <div class="carousel-outer" role="group" aria-label="Customer testimonials">
      <div class="track">${doubled}</div>
    </div>
  `;

  const css = `
    :host { display: block; font-family: system-ui, sans-serif; overflow: hidden; }
    .carousel-outer { width: 100%; overflow: hidden; }
    .track {
      display: flex;
      gap: ${GAP}px;
      width: calc(${2 * N * CARD}px + ${GAP}px * ${2 * N - 1});
      animation: scroll-left 40s linear infinite;
    }
    /* WCAG 2.2.2 (Pause, Stop, Hide): let the reader stop the motion to read. */
    .carousel-outer:hover .track,
    .carousel-outer:focus-within .track {
      animation-play-state: paused;
    }
    @keyframes scroll-left {
      0% { transform: translateX(0); }
      100% { transform: translateX(${-N * step}px); }
    }
    /* Respect users who ask for reduced motion: stop the marquee and let them
       see the strip as a static wrapped grid instead of continuous animation. */
    @media (prefers-reduced-motion: reduce) {
      .track { animation: none; flex-wrap: wrap; width: 100%; }
      /* The duplicate set only exists to make the loop seamless; with the
         animation off it would just be repeated cards, so drop it. */
      .card[aria-hidden] { display: none; }
    }
    .card {
      flex: 0 0 300px;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.04);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-sizing: border-box;
    }
    .quote-text {
      font-size: 0.9rem;
      line-height: 1.55;
      color: #1a1a1a;
      flex: 1;
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
      overflow: hidden;
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
      font-size: 0.78rem;
      color: #6b7280;
      font-weight: 500;
    }
    .source-badge {
      font-size: 0.68rem;
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
