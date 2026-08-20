import { Hono } from "hono";
import type { Env } from "../../worker";
import { getCached, putCached, buildCacheUrl } from "../../lib/cache";
import { ProductsDB, TestimonialsDB } from "../../db/queries";
import type { Product } from "../../db/queries";
import { CRM_ORIGIN, getAuthenticatedFeedbackOrigins } from "../../config/product-origins";

export const VALID_WIDGETS = ["wall-grid", "wall-carousel", "single-quote", "rating-badge", "feedback-button"] as const;
type WidgetType = (typeof VALID_WIDGETS)[number];

// The ingest endpoint handed to embedded widgets must be https for any real
// host: customer sites are served over https, so an http endpoint is blocked
// as mixed content (and the http→https redirect breaks the CORS preflight).
// Only localhost keeps its original scheme so local dev can post to :8787.
export function resolveCrmOrigin(reqUrl: string): string {
  const url = new URL(reqUrl);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const scheme = isLocal ? url.protocol.replace(":", "") : "https";
  return `${scheme}://${url.host}`;
}

const LOADER_JS = `(function(){
  var currentScript = document.currentScript && document.currentScript.getAttribute
    ? document.currentScript
    : null;
  var scripts = document.querySelectorAll('script[data-product][data-widget]');
  var current = currentScript || scripts[scripts.length - 1];
  if (!current) return;
  var product = current.getAttribute('data-product');
  var widget = current.getAttribute('data-widget');
  if (!product || !widget) return;
  var loaderUrl = new URL(current.src || '/w/v1.js', window.location.href);
  var dataBase = current.getAttribute('data-api-base') || (loaderUrl.origin + '/w/data');
  dataBase = dataBase.replace(/\\/$/, '');

  var host = document.createElement('div');
  current.parentNode && current.parentNode.insertBefore(host, current);
  var shadow = host.attachShadow({ mode: 'open' });

  fetch(dataBase + '/' + encodeURIComponent(product) + '/' + encodeURIComponent(widget))
    .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function(data){
      var html = data.__html || '';
      var css = data.__css || '';
      shadow.innerHTML = '<style>' + css + '</style>' + html;
      if (widget === 'feedback-button') {
        initFeedbackButton(shadow, data);
      }
    })
    .catch(function(e){ console.warn('[ventora-widget] load failed', e); });

  function initFeedbackButton(shadow, data) {
    var fab = shadow.getElementById('vtFabBtn');
    var backdrop = shadow.getElementById('vtBackdrop');
    var closeBtn = shadow.getElementById('vtClose');
    var form = shadow.getElementById('vtForm');
    var statusEl = shadow.getElementById('vtStatus');
    var ingestUrl = data.ingest_url || extractLegacyIngestUrl(data.__js);
    if (!fab || !backdrop || !closeBtn || !form || !statusEl || !ingestUrl) return;

    fab.addEventListener('click', function() {
      backdrop.hidden = false;
    });
    closeBtn.addEventListener('click', function() {
      backdrop.hidden = true;
    });
    backdrop.addEventListener('click', function(e) {
      if (e.target === backdrop) backdrop.hidden = true;
    });

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      var titleEl = shadow.getElementById('vtTitle');
      var bodyEl = shadow.getElementById('vtBody');
      var emailEl = shadow.getElementById('vtEmail');
      var typeEl = shadow.getElementById('vtType');
      var payload = {
        type: typeEl.value,
        title: titleEl.value.trim(),
        body: bodyEl.value.trim() || undefined,
        customer_email: emailEl.value.trim() || undefined
      };
      if (!payload.title) {
        showStatus('Title is required.', true);
        return;
      }
      var btn = form.querySelector('.submit-btn');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      var headers = { 'Content-Type': 'application/json' };
      var extraHeaders = data.ingest_headers || {};
      Object.keys(extraHeaders).forEach(function(key) {
        if (typeof extraHeaders[key] === 'string') headers[key] = extraHeaders[key];
      });
      fetch(ingestUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      })
        .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }); })
        .then(function(res) {
          if (res.ok) {
            showStatus('Thank you for your feedback!', false);
            form.reset();
          } else {
            showStatus(res.body.error || 'Something went wrong.', true);
          }
        })
        .catch(function() { showStatus('Network error. Please try again.', true); })
        .finally(function() { btn.disabled = false; btn.textContent = 'Submit'; });
    });

    function showStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.className = 'status ' + (isError ? 'error' : 'success');
      statusEl.hidden = false;
      setTimeout(function() { statusEl.hidden = true; }, 4000);
    }

    function extractLegacyIngestUrl(js) {
      if (typeof js !== 'string') return '';
      var match = js.match(/https?:\\/\\/[^"']+\\/w\\/ingest\\/[^"']+/);
      return match ? match[0] : '';
    }
  }
})();`;

const router = new Hono<{ Bindings: Env }>();

interface OriginPolicy {
  allowed: boolean;
  error?: string;
}

type AllowlistParseResult =
  | { ok: true; origins: string[] }
  | { ok: false };

function isAbsoluteOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  } catch {
    return false;
  }
}

function parseAllowlist(json: string): AllowlistParseResult {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string" && isAbsoluteOrigin(x))) {
      return { ok: true, origins: parsed };
    }
  } catch {
    return { ok: false };
  }
  return { ok: false };
}

export function getOriginPolicy(
  productSlug: string,
  widget: WidgetType,
  originAllowlistJson: string,
  requestOrigin: string,
): OriginPolicy {
  const allowlistResult = parseAllowlist(originAllowlistJson);
  if (!allowlistResult.ok) {
    return { allowed: false, error: "invalid origin allowlist" };
  }
  const allowlist = allowlistResult.origins;
  if (widget === "feedback-button" && allowlist.length === 0) {
    return { allowed: false, error: "feedback widget is not enabled for this product" };
  }
  // Empty-allowlist policy (intentional): display widgets (wall-grid/carousel/single-quote/
  // rating-badge) render only APPROVED testimonials — public content meant to be embeddable from
  // any origin — so an unset allowlist leaves them fully public rather than blocked. The
  // feedback-button is the sole exception and is already rejected above when the allowlist is empty.
  if (allowlist.length > 0) {
    if (!requestOrigin) {
      return { allowed: false, error: "origin required" };
    }
    if (requestOrigin && !allowlist.includes(requestOrigin)) {
      return { allowed: false, error: "origin not allowed" };
    }
  }
  if (widget === "feedback-button") {
    const authenticatedOrigins = getAuthenticatedFeedbackOrigins(productSlug);
    if (requestOrigin !== CRM_ORIGIN && !authenticatedOrigins.includes(requestOrigin)) {
      return {
        allowed: false,
        error: "feedback widget is only enabled on authenticated product surfaces",
      };
    }
  }
  return { allowed: true };
}

router.get("/v1.js", () => {
  return new Response(LOADER_JS, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});

router.get("/data/:productKey/:widget", async (c) => {
  const productKey = c.req.param("productKey");
  const widgetParam = c.req.param("widget");

  if (!(VALID_WIDGETS as readonly string[]).includes(widgetParam)) {
    return c.json({ error: `unknown widget type: ${widgetParam}` }, 400);
  }
  const widget = widgetParam as WidgetType;

  const product = await ProductsDB.getByWidgetKey(c.env.DB, productKey);
  if (!product) {
    return c.json({ error: "product not found" }, 404);
  }

  const requestOrigin = c.req.header("Origin") ?? "";
  const originPolicy = getOriginPolicy(product.slug, widget, product.origin_allowlist_json, requestOrigin);
  if (!originPolicy.allowed) {
    return c.json({ error: originPolicy.error }, 403);
  }

  return buildWidgetDataResponse(c.env, c.req.url, product, widget, { useCache: true });
});

export async function buildWidgetDataResponse(
  env: Env,
  requestUrl: string,
  product: Product,
  widget: WidgetType,
  options: { useCache: boolean; ingestPathPrefix?: string; ingestHeaders?: Record<string, string> },
): Promise<Response> {
  const cacheReq = options.useCache && widget !== "feedback-button" ? new Request(buildCacheUrl(product.slug, widget)) : null;
  const cached = cacheReq ? await getCached(cacheReq) : null;
  if (cached) return cached;

  let payload: Record<string, unknown>;

  if (widget === "wall-grid" || widget === "wall-carousel") {
    const rows = await TestimonialsDB.listByProduct(env.DB, product.id, {
      approvedOnly: true,
      limit: 20,
    });
    const customerIds = [...new Set(rows.map((r) => r.customer_id))];
    const customerMap = await buildCustomerMap(env.DB, customerIds);

    payload = {
      testimonials: rows.map((r) => ({
        quote: r.quote,
        customer_name: customerMap[r.customer_id]?.name ?? "Anonymous",
        customer_role: customerMap[r.customer_id]?.role ?? null,
        customer_company: customerMap[r.customer_id]?.company ?? null,
        rating: r.rating,
        source: r.source,
      })),
    };
  } else if (widget === "single-quote") {
    const rows = await TestimonialsDB.listByProduct(env.DB, product.id, {
      approvedOnly: true,
      featuredOnly: true,
      limit: 1,
    });
    const row = rows[0] ?? null;
    if (row) {
      const customer = await getCustomer(env.DB, row.customer_id);
      payload = {
        testimonial: {
          quote: row.quote,
          customer_name: customer?.name ?? "Anonymous",
          customer_role: customer?.role ?? null,
          customer_company: customer?.company ?? null,
          rating: row.rating,
          source: row.source,
        },
      };
    } else {
      payload = { testimonial: null };
    }
  } else if (widget === "rating-badge") {
    const result = await env.DB
      .prepare(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as total
         FROM testimonials
         WHERE product_id = ? AND approved = 1 AND rating IS NOT NULL`,
      )
      .bind(product.id)
      .first<{ avg_rating: number | null; total: number }>();

    payload = {
      average_rating: result?.avg_rating ?? 0,
      total_count: result?.total ?? 0,
      product_name: product.name,
    };
  } else {
    payload = {
      product_name: product.name,
      product_slug: product.slug,
      widget_public_key: product.widget_public_key,
      // resolveCrmOrigin forces https for real hosts so embedded widgets never
      // hit a mixed-content endpoint (plain new URL().origin would not).
      crm_origin: resolveCrmOrigin(requestUrl),
      brand_color: product.brand_color,
      ingest_url: `${resolveCrmOrigin(requestUrl)}${options.ingestPathPrefix ?? "/w/ingest"}/${encodeURIComponent(product.widget_public_key)}`,
      ...(options.ingestHeaders ? { ingest_headers: options.ingestHeaders } : {}),
    };
  }

  const { renderWallGrid } = await import("../../widgets/wall-grid");
  const { renderWallCarousel } = await import("../../widgets/wall-carousel");
  const { renderSingleQuote } = await import("../../widgets/single-quote");
  const { renderRatingBadge } = await import("../../widgets/rating-badge");
  const { renderFeedbackButton } = await import("../../widgets/feedback-button");

  let rendered: { html: string; css: string; js?: string };
  if (widget === "wall-grid") {
    rendered = renderWallGrid(payload as Parameters<typeof renderWallGrid>[0]);
  } else if (widget === "wall-carousel") {
    rendered = renderWallCarousel(payload as Parameters<typeof renderWallCarousel>[0]);
  } else if (widget === "single-quote") {
    rendered = renderSingleQuote(payload as Parameters<typeof renderSingleQuote>[0]);
  } else if (widget === "rating-badge") {
    rendered = renderRatingBadge(payload as Parameters<typeof renderRatingBadge>[0]);
  } else {
    rendered = renderFeedbackButton(payload as Parameters<typeof renderFeedbackButton>[0]);
  }

  const renderedJs = (rendered as { html: string; css: string; js?: string }).js;
  const responsePayload = {
    ...payload,
    __html: rendered.html,
    __css: rendered.css,
    ...(widget !== "feedback-button" && renderedJs !== undefined ? { __js: renderedJs } : {}),
  };
  const responseBody = JSON.stringify(responsePayload);
  const responseHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": widget === "feedback-button" ? "no-store" : "public, max-age=300",
  };
  const response = new Response(responseBody, { headers: responseHeaders });
  if (cacheReq) {
    await putCached(cacheReq, response.clone());
  }
  return new Response(responseBody, { headers: responseHeaders });
}

async function buildCustomerMap(
  db: D1Database,
  ids: string[],
): Promise<Record<string, { name: string; role: string | null; company: string | null }>> {
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => "?").join(",");
  const result = await db
    .prepare(`SELECT id, name, role, company FROM customers WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; name: string; role: string | null; company: string | null }>();
  const map: Record<string, { name: string; role: string | null; company: string | null }> = {};
  for (const row of result.results) {
    map[row.id] = { name: row.name, role: row.role, company: row.company };
  }
  return map;
}

async function getCustomer(
  db: D1Database,
  id: string,
): Promise<{ name: string; role: string | null; company: string | null } | null> {
  return db
    .prepare("SELECT name, role, company FROM customers WHERE id = ?")
    .bind(id)
    .first<{ name: string; role: string | null; company: string | null }>();
}

export default router;
