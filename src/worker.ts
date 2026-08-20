/**
 * Ventora CRM — Worker entry point.
 *
 * Routes are mounted in 3 buckets, each with its own auth posture:
 *   /api/admin/*   — requires CF Access JWT (or DEV_AUTH_BYPASS=true locally)
 *   /w/*           — public, rate-limited / origin-checked per route
 *   /preview/*     — admin-only sandbox that renders widgets against real data
 *
 * The admin SPA itself is served by the ASSETS binding (Workers Static Assets);
 * the Worker only intercepts non-asset paths.
 */

import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { requireAccess, requireAdminMutationProtection } from "./lib/auth";
import widgetRouter from "./routes/widget/index";
import ingestRouter from "./routes/ingest/index";
import sdrIngestRouter from "./routes/sdr-ingest/index";
import previewRouter from "./routes/preview/index";
import settingsRouter from "./routes/admin/settings";
import dashboardRouter from "./routes/admin/dashboard";
import customersRouter from "./routes/admin/customers";
import testimonialsRouter from "./routes/admin/testimonials";
import feedbackRouter from "./routes/admin/feedback";
import reviewsRouter from "./routes/admin/reviews";
import mediaRouter from "./routes/admin/media";
import sdrLeadsRouter from "./routes/admin/sdr-leads";
import { pollReviewConnectors } from "./cron/poll-reviews";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  /**
   * HMAC shared secret for the AI-SDR server-to-server lead-ingest route (/s/ingest/leads).
   * Required in production (set via `wrangler secret put CRM_INGEST_SECRET`).
   * Optional in type to avoid breaking tests for unrelated routes; the ingest handler
   * will throw at runtime if this is absent.
   */
  CRM_INGEST_SECRET?: string;
  DEV_AUTH_BYPASS?: string;
  DEV_AUTH_BYPASS_ALLOW_NONLOCAL_HOST?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_JWKS_URL?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const host = (c.req.header("X-Forwarded-Host") ?? c.req.header("Host") ?? "").split(":")[0]?.toLowerCase();
  if (url.hostname === "widgets.ventoralabs.com" || host === "widgets.ventoralabs.com") {
    const allowed =
      url.pathname === "/healthz" ||
      url.pathname === "/w" ||
      url.pathname.startsWith("/w/") ||
      url.pathname.startsWith("/media/") ||
      // S2S lead intake (HMAC-authed). crm.ventoralabs.com sits behind Cloudflare
      // Access, so the AI-SDR signing Worker cannot reach it there; the public
      // widgets host is its ingress. Authentication is the in-route HMAC guard,
      // not the host partition. The trailing slash is required, so bare /s/ingest
      // and every other /s/* path stay partitioned off (404) — only /s/ingest/*
      // is exposed.
      url.pathname.startsWith("/s/ingest/");
    if (!allowed) {
      return c.json({ error: "not found" }, 404);
    }
  }
  await next();
});

// CORS is required only for /w/* (public widget API hit from product sites).
// Admin API is same-origin (served alongside SPA).
app.use(
  "/w/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Origin"],
    maxAge: 600,
  }),
);

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/healthz", (c) => c.json({ ok: true, service: "ventora-crm", schema_compat: 2 }));

// ---------------------------------------------------------------------------
// Admin API — gated behind Cloudflare Access (Google SSO).
// ---------------------------------------------------------------------------
const admin = new Hono<{ Bindings: Env }>();
admin.use("*", requireAccess);
admin.use("*", requireAdminMutationProtection);
admin.get("/me", (c) => {
  const email = c.get("accessEmail" as never) as string | undefined;
  return c.json({ email: email ?? "dev@local" });
});
admin.route("/dashboard", dashboardRouter);
admin.route("/customers", customersRouter);
admin.route("/testimonials", testimonialsRouter);
admin.route("/feedback", feedbackRouter);
admin.route("/reviews", reviewsRouter);
admin.route("/settings", settingsRouter);
admin.route("/media", mediaRouter);
admin.route("/sdr-leads", sdrLeadsRouter);
app.route("/api/admin", admin);

// ---------------------------------------------------------------------------
// Public media — serves R2 objects (customer avatars, testimonial photos).
// Object keys are opaque UUIDs, so this is safe to expose unauthenticated.
// ---------------------------------------------------------------------------
app.get("/media/:key{.+}", async (c) => {
  const rawKey = c.req.param("key");
  if (!rawKey || rawKey.includes("..")) {
    return c.json({ error: "not found" }, 404);
  }
  const key = rawKey.startsWith("media/") ? rawKey : `media/${rawKey}`;
  const liveAsset = await c.env.DB
    .prepare("SELECT 1 FROM media_assets WHERE key = ? AND deleted_at IS NULL")
    .bind(key)
    .first<{ "1": number }>();
  if (!liveAsset) return c.json({ error: "not found" }, 404);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(obj.body, { headers });
});

// ---------------------------------------------------------------------------
// Server-to-server API — /s/* (AI-SDR worker → CRM intake).
// No CORS — this namespace is never called from a browser.
// The real router is mounted BEFORE the catch-all guards so Hono matches it first.
// ---------------------------------------------------------------------------
app.route("/s/ingest/leads", sdrIngestRouter);
// Keep unmatched /s paths from falling through to the admin SPA.
app.all("/s", (c) => c.json({ error: "not found" }, 404));
app.all("/s/*", (c) => c.json({ error: "not found" }, 404));

// ---------------------------------------------------------------------------
// Public widget API — /w/ingest/* first (more specific), then /w/*.
// ---------------------------------------------------------------------------
app.route("/w/ingest", ingestRouter);
app.route("/w", widgetRouter);

// ---------------------------------------------------------------------------
// Preview sandbox — admin-only, renders each widget against real D1 data.
// ---------------------------------------------------------------------------
app.use("/preview", requireAccess);
app.use("/preview/*", requireAccess);
app.route("/preview", previewRouter);

// Keep Worker-reserved prefixes from falling through to the admin SPA.
app.all("/api", (c) => c.json({ error: "not found" }, 404));
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.all("/media", (c) => c.json({ error: "not found" }, 404));
app.all("/media/*", (c) => c.json({ error: "not found" }, 404));
app.all("/preview", (c) => c.json({ error: "not found" }, 404));
app.all("/preview/*", (c) => c.json({ error: "not found" }, 404));
app.all("/w", (c) => c.json({ error: "not found" }, 404));
app.all("/w/*", (c) => c.json({ error: "not found" }, 404));

// ---------------------------------------------------------------------------
// Fallback: hand non-API requests to the static-asset binding (admin SPA).
// ---------------------------------------------------------------------------
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pollReviewConnectors(env));
  },
} satisfies ExportedHandler<Env>;
