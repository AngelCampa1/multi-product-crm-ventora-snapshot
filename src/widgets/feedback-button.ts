import { escapeHtml } from "./render-utils";

export function renderFeedbackButton(data: {
  product_name: string;
  product_slug: string;
  widget_public_key: string;
  crm_origin?: string;
  brand_color?: string | null;
  label?: string;
}): { html: string; css: string } {
  const label = data.label ?? "Send Feedback";
  const brandColor = normalizeHexColor(data.brand_color) ?? "#4f46e5";
  const hoverColor = darkenHexColor(brandColor, 0.14);
  const shadowColor = hexToRgb(brandColor);
  const shadow = `rgba(${shadowColor.r},${shadowColor.g},${shadowColor.b},0.4)`;

  const html = `
    <div class="wrapper">
      <button class="fab" id="vtFabBtn" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</button>
      <div class="modal-backdrop" id="vtBackdrop" hidden>
        <div class="modal" role="dialog" aria-modal="true" aria-label="Feedback">
          <div class="modal-header">
            <h2 class="modal-title">Send Feedback</h2>
            <button class="close-btn" id="vtClose" aria-label="Close">&times;</button>
          </div>
          <form id="vtForm" novalidate>
            <div class="field">
              <label class="label" for="vtType">Type</label>
              <select class="input" id="vtType" name="type" required>
                <option value="feature_request">Feature Request</option>
                <option value="bug">Bug</option>
                <option value="general">General</option>
              </select>
            </div>
            <div class="field">
              <label class="label" for="vtTitle">Title</label>
              <input class="input" id="vtTitle" name="title" type="text" placeholder="Short summary" required />
            </div>
            <div class="field">
              <label class="label" for="vtBody">Description</label>
              <textarea class="input" id="vtBody" name="body" rows="4" placeholder="Details (optional)"></textarea>
            </div>
            <div class="field">
              <label class="label" for="vtEmail">Email (optional)</label>
              <input class="input" id="vtEmail" name="customer_email" type="email" placeholder="your@email.com" />
            </div>
            <div id="vtStatus" class="status" hidden></div>
            <button class="submit-btn" type="submit">Submit</button>
          </form>
        </div>
      </div>
    </div>
  `;

  const css = `
    :host { display: block; font-family: system-ui, sans-serif; }
    .fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: ${brandColor};
      color: #fff;
      border: none;
      border-radius: 9999px;
      padding: 12px 22px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 14px ${shadow};
      z-index: 9999;
      transition: background 0.15s;
    }
    .fab:hover { background: ${hoverColor}; }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    }
    .modal-backdrop[hidden] { display: none; }
    .modal {
      background: #fff;
      border-radius: 12px;
      width: 100%;
      max-width: 440px;
      margin: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      overflow: hidden;
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px 12px;
      border-bottom: 1px solid #f3f4f6;
    }
    .modal-title {
      font-size: 1.05rem;
      font-weight: 600;
      color: #111827;
      margin: 0;
    }
    .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      line-height: 1;
      color: #9ca3af;
      cursor: pointer;
      padding: 0 4px;
    }
    .close-btn:hover { color: #374151; }
    form { padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 14px; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .label { font-size: 0.82rem; font-weight: 500; color: #374151; }
    .input {
      padding: 8px 10px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 0.9rem;
      color: #111827;
      outline: none;
      transition: border-color 0.15s;
      font-family: inherit;
      resize: vertical;
      background: #fff;
    }
    .input:focus { border-color: ${brandColor}; }
    .status {
      font-size: 0.84rem;
      border-radius: 6px;
      padding: 8px 10px;
    }
    .status[hidden] { display: none; }
    .status.success { background: #ecfdf5; color: #065f46; }
    .status.error { background: #fef2f2; color: #991b1b; }
    .submit-btn {
      background: ${brandColor};
      color: #fff;
      border: none;
      border-radius: 9999px;
      padding: 10px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .submit-btn:hover:not(:disabled) { background: ${hoverColor}; }
    .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  `;

  return { html, css };
}

function normalizeHexColor(color: string | null | undefined): string | null {
  if (!color) return null;
  const value = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return null;
}

function darkenHexColor(color: string, amount: number): string {
  const rgb = hexToRgb(color);
  const darken = (channel: number) => Math.max(0, Math.round(channel * (1 - amount)));
  return rgbToHex(darken(rgb.r), darken(rgb.g), darken(rgb.b));
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const value = Number.parseInt(color.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

