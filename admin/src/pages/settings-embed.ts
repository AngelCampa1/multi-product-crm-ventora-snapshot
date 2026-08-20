export const PUBLIC_WIDGET_LOADER_SRC = "https://widgets.ventoralabs.com/w/v1.js";

export function buildEmbedSnippet(widgetPublicKey: string, widget: string): string {
  return `<script src="${PUBLIC_WIDGET_LOADER_SRC}" data-product="${escapeHtmlAttribute(widgetPublicKey)}" data-widget="${escapeHtmlAttribute(widget)}"></script>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
