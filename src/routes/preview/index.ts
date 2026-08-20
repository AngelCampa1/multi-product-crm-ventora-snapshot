import { Hono } from "hono";
import type { Env } from "../../worker";
import { ProductsDB } from "../../db/queries";
import { buildWidgetDataResponse, VALID_WIDGETS } from "../widget/index";
import { createFeedbackSubmission, readBoundedFeedbackJson } from "../ingest/index";
import { requireAdminMutationProtection } from "../../lib/auth";

const router = new Hono<{ Bindings: Env }>();

router.get("/data/:productKey/:widget", async (c) => {
  const productKey = c.req.param("productKey");
  const widgetParam = c.req.param("widget");

  if (!(VALID_WIDGETS as readonly string[]).includes(widgetParam)) {
    return c.json({ error: `unknown widget type: ${widgetParam}` }, 400);
  }

  const product = await ProductsDB.getByWidgetKey(c.env.DB, productKey);
  if (!product) {
    return c.json({ error: "product not found" }, 404);
  }

  return buildWidgetDataResponse(c.env, c.req.url, product, widgetParam as (typeof VALID_WIDGETS)[number], {
    useCache: false,
    ingestPathPrefix: "/preview/ingest",
    ingestHeaders: { "X-Ventora-CSRF": "1" },
  });
});

router.post("/ingest/:productKey", requireAdminMutationProtection, async (c) => {
  const productKey = c.req.param("productKey") ?? "";
  const product = await ProductsDB.getByWidgetKey(c.env.DB, productKey);
  if (!product) {
    return c.json({ error: "product not found" }, 404);
  }

  const parsedBody = await readBoundedFeedbackJson(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({ error: parsedBody.error }, parsedBody.status);
  }
  const result = await createFeedbackSubmission(c.env.DB, product, parsedBody.value);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status);
  }

  return c.json({ ok: true, id: result.id }, 201);
});

router.get("/:productSlug/:widget", async (c) => {
  const productSlug = c.req.param("productSlug");
  const widget = c.req.param("widget");

  if (!(VALID_WIDGETS as readonly string[]).includes(widget)) {
    return c.json({ error: `unknown widget type: ${widget}` }, 400);
  }

  const product = await ProductsDB.getBySlug(c.env.DB, productSlug);

  if (!product) {
    return c.json({ error: "product not found" }, 404);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Widget Preview — ${escapeHtml(productSlug)} / ${escapeHtml(widget)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      min-height: 100vh;
    }
    .banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #fffbeb;
      border-bottom: 1px solid #fde68a;
      color: #92400e;
      font-size: 0.8rem;
      font-weight: 500;
      padding: 9px 20px;
      text-align: center;
    }
    .banner svg { flex: none; }
    .container { max-width: 1024px; margin: 0 auto; padding: 28px 24px 48px; }
    .meta {
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .meta h1 { font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; }
    .meta .chip {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #475569;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 999px;
      padding: 3px 9px;
    }
    .stage {
      position: relative;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      min-height: 160px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      overflow: hidden;
    }
    .stage > .mount { position: relative; z-index: 1; }
    .empty {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      text-align: center;
      padding: 48px 24px;
      color: #64748b;
    }
    .empty.show { display: flex; }
    .empty .title { font-size: 0.9rem; font-weight: 600; color: #334155; }
    .empty .sub { font-size: 0.82rem; max-width: 30rem; line-height: 1.5; }
    .empty svg { color: #cbd5e1; margin-bottom: 4px; }
  </style>
</head>
<body>
  <div class="banner">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
    Preview mode — renders against live data. Nothing here is published.
  </div>
  <div class="container">
    <div class="meta">
      <h1>${escapeHtml(product.name)}</h1>
      <span class="chip">${escapeHtml(widget)}</span>
    </div>
    <div class="stage">
      <div class="mount">
        <script
          src="/w/v1.js"
          data-product="${escapeHtml(product.widget_public_key)}"
          data-widget="${escapeHtml(widget)}"
          data-api-base="/preview/data"
        ></script>
      </div>
      <div class="empty" id="vt-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        <div class="title">This widget is empty</div>
        <div class="sub">The widget loaded correctly — there's just no approved content for ${escapeHtml(product.name)} yet. Approve a testimonial and it will appear here and on any embedded site.</div>
      </div>
    </div>
  </div>
  <script>
    // If the widget mounts with no visible content, reveal the empty-state hint
    // so the admin can tell the widget loaded rather than failed.
    (function () {
      var stage = document.querySelector('.stage');
      var mount = stage && stage.querySelector('.mount');
      var empty = document.getElementById('vt-empty');
      if (!stage || !mount || !empty) return;
      function hasContent() {
        var host = mount.querySelector('*');
        if (!host) return false; // loader hasn't mounted yet
        var root = host.shadowRoot;
        if (!root) return mount.offsetHeight > 40; // non-shadow widget: fall back to height
        // Scan rendered nodes (ignoring <style>/<script>, whose textContent is
        // CSS/JS and would always read as "content"). Real content means visible
        // text or an image somewhere in the widget.
        var nodes = root.querySelectorAll('*:not(style):not(script)');
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.tagName === 'IMG') return true;
          if (n.children.length === 0 && n.textContent.trim().length > 0) return true;
        }
        return false;
      }
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (hasContent()) { clearInterval(timer); return; }
        if (tries >= 12) { clearInterval(timer); empty.classList.add('show'); }
      }, 150);
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default router;
