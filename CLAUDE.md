# CLAUDE.md

## Design Canon

- **Buttons are pills.** Treat fully rounded button geometry as a standing product preference. Every button or button-styled CTA should use pill corners (`border-radius: 9999px`, `rounded-full`, or equivalent), including primary/secondary actions, link-buttons, toolbar buttons, segmented/toggle controls, and icon buttons (circular when square). Do not introduce square or mildly rounded button shapes unless the user explicitly asks for that exception.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ventora CRM — an internal customer hub + Wall of Fame for the Ventora product portfolio. One Cloudflare Worker serves three surfaces: an admin SPA, a public widget API, and an admin-only preview sandbox. Deployed to `crm.ventoralabs.com`.

Start with `portfolio/ARCHITECTURE.md` for the system shape, `portfolio/SECURITY.md` for the trust boundaries, and `portfolio/TESTING.md` for how the suite is organized.

## Commands

```bash
npm run dev              # concurrent: admin Vite build --watch + wrangler dev (:8787)
npm run dev:worker       # worker only
npm run dev:admin        # admin SPA only (Vite dev server, proxies /api → :8787)
npm run build:admin      # produces admin/dist (consumed by ASSETS binding)
npm run deploy           # build admin, remote migrate/seed/origins/verify, then wrangler deploy
npm run verify:rollout   # lint, typecheck, coverage, local migration/seed/origins/verify, e2e, dry-run deploy

npm run db:migrate            # apply migrations to local D1
npm run db:seed               # tsx scripts/seed-products.ts — reads tests/fixtures/products/*.md
npm run db:origins            # configure local product origin allowlists
npm run verify:migration      # verify local seeded/origin state

npm test                                  # vitest run (unit only)
npm run test:watch
npm run test:admin                        # admin SPA component tests (jsdom project)
npm run test:coverage                     # enforces 95% thresholds on the security-critical modules
npx vitest run tests/unit/firewall.test.ts -t "name"   # single test
npm run test:e2e                          # playwright

npm run metrics          # regenerate portfolio/METRICS.md + the README metrics table
npm run metrics:check    # fail if the published numbers have drifted from the code
npm run shots            # rebuild the local demo DB and recapture docs/screenshots/

npm run typecheck        # tsc --noEmit
npm run lint             # eslint .ts/.tsx
```

Local secrets live in `.dev.vars` (copy from `.dev.vars.example`). The most important one is `DEV_AUTH_BYPASS=true`, which short-circuits CF Access JWT verification — only `src/lib/auth.ts` reads it.

## Architecture

### Single Worker, three route buckets

`src/worker.ts` is the entry point. Routes are partitioned by auth posture, and getting this wrong is the most common way to break things:

- `/api/admin/*` — guarded by `requireAccess` (CF Access JWT → `c.get("accessEmail")`). All admin CRUD lives here.
- `/w/*` — public, CORS-enabled (`origin: "*"`). Widgets on customer product sites hit this. Per-route rate limiting / origin checks live in the route handlers, not middleware.
- `/preview/*` — admin-only sandbox that renders widgets against real D1 data.
- `/s/ingest/leads/:productKey` — HMAC-signed server-to-server lead ingest.
- Reserved prefixes then hit explicit `app.all` 404 guards, so the SPA fallback can't shadow them. Everything else falls through to the `ASSETS` binding, which serves the React SPA from `admin/dist`.

Route order is load-bearing: routers mount before the guards, and the guards mount before the SPA fallback.

The `scheduled` handler (cron `0 */6 * * *`) calls `pollReviewConnectors` — a no-op until a connector is configured.

### Storage

- **D1** (`DB` binding, db name `ventora-crm`) — authoritative schema in `migrations/`. `src/db/schema.sql` is a stub mirror for IDE awareness only; **wrangler applies migrations from `/migrations`**, so any schema change must land as a new migration file.
- **R2** (`MEDIA`) — customer avatars / testimonial photos, gated by the `media_assets` registry.
- **Workers Cache API** (`caches.default`) — used by `src/lib/cache.ts` for `/w/data/*` and `/w/v1.js`. Synthetic cache URLs are built by `buildCacheUrl(productSlug, widget)`; bust precisely on testimonial approval/feature changes. **No KV** (cost) — do not introduce a KV binding without revisiting the design.

### Conflict-of-interest firewall (critical business rule)

`src/lib/firewall.ts` enforces product firewall groups. Some products sit on opposite sides of the same commercial transaction, so a customer of one must never be reachable as a customer of the other. Products carry a nullable `firewall_group`; a customer may be linked to at most one product per group.

The check unions four tables — `customer_products`, `testimonials`, `reviews`, `feedback_items` — because the association can form through any of them, not just an explicit link. `assertFirewallSafe(db, customerId, candidateProductId)` must be called **before** every insert into `customer_products`; it throws `FirewallViolation` on conflict.

The same invariant is enforced again in SQL, by `BEFORE INSERT`/`BEFORE UPDATE` triggers that `RAISE(ABORT, 'FIREWALL_VIOLATION')`. The TypeScript layer exists to produce a good error message; the trigger layer exists because the application can be bypassed by a migration, a repair script, or a route someone forgets to guard. Do not remove either layer.

D1 statements are not atomic across calls, so wrap the check + insert in a transaction upstream when strict atomicity matters.

### Admin SPA

`admin/` is a separate Vite project with its own `tsconfig.json` and Tailwind config. Build output goes to `admin/dist`, which is what `wrangler.jsonc` points the `ASSETS` binding at. `npm run dev` runs `vite build --watch` (not Vite dev server) so the worker's ASSETS binding stays populated; `npm run dev:admin` runs the regular Vite dev server with `/api` proxied to `:8787`.

Path aliases: `@/*` → `src/*`, `@admin/*` → `admin/src/*`.

### Widgets

Embeddable widgets (`wall-grid`, `wall-carousel`, `single-quote`, `rating-badge`, `feedback-button`) are server-rendered to HTML+CSS strings and shipped inside a Shadow DOM via a tiny loader at `/w/v1.js`. They are dynamically imported so the cold-start bundle stays small. Origin allowlist + widget public key live on the `products` row.

### Review connectors

`src/connectors/*` — pluggable. Ships manual paste, CSV, RSS, and public-page scrapers (G2, Trustpilot). API-backed connectors (`g2-api.ts`, `trustpilot-api.ts`, `twitter.ts`) are scaffolded but not wired up. Dedup is `UNIQUE (source, external_id)` in `reviews`.

## Constraints baked into the project

- **TDD with 95% coverage on touched files.** Vitest coverage thresholds in `vitest.config.ts` are scoped to the security-critical modules — when you add code to that scope or extend the `include` list, the thresholds bite.
- `auth.ts` and `cache.ts` depend on Workers runtime globals (`crypto.subtle`, `caches.default`) and are intentionally excluded from node-based unit tests — exercise them via integration tests against `wrangler dev`, not by mocking the globals.
- **No fabricated testimonials in production data.** All Ventora products are pre-launch. Remote and production seeds must never invent quotes or ratings, and no fabricated quote may ever reach a live widget.

  The one permitted exception is the local-only demo dataset in `scripts/seed-demo.ts`, which exists so the repository can be documented with screenshots. It uses obviously fictional companies and `@example.com` addresses, is hard-blocked from remote D1, writes to an isolated `.wrangler-demo/` store, and every screenshot it produces is labeled as fictional. Do not extend it toward realism, and do not let it touch the default local store.
- **Conventional commits.** Match recent history (`feat(scope):`, `fix(scope):`, `chore:`).
- Windows host: `.gitattributes` enforces LF endings. Avoid `2>&1` on native commands in PowerShell (wraps stderr as ErrorRecord and flips `$?`).

## Production deploy checklist

- `wrangler.jsonc` contains the production custom domains for `crm.ventoralabs.com` and `widgets.ventoralabs.com`. The `database_id` is a placeholder — create your own D1 with `wrangler d1 create ventora-crm` and paste the returned id.
- Confirm Cloudflare Access protects `crm.ventoralabs.com` admin and preview routes, then set production secrets with `wrangler secret put CF_ACCESS_TEAM_DOMAIN` and `wrangler secret put CF_ACCESS_AUD`.
- Before deploy, run `npm run verify:rollout`.
- Deploy with `npm run deploy`.
- Post-deploy smoke URLs: `/admin`, `/preview/camaudit-v2/wall-grid`, `/w/v1.js`, and `tests/fixtures/embed-sandbox.html`.
- Day-one widget walls may be empty until real testimonials are approved; do not seed or screenshot fabricated quotes into production.

## AI Agent Orchestration

AI agent instances operating in this repository are orchestrators. They must delegate exploration, implementation, verification, and other execution work to sub-agents whenever the work can be cleanly scoped, preserving the orchestrator's context window for coordination, integration, and final judgment.

## User-Facing Copy Guardrails

For any user-facing copy in this repo, run the copy through these guardrails before you call the work done. This applies to product UI text, hero copy, CTAs, onboarding copy, emails, popups, help text, empty states, reassurance text, and any copy that sells, explains, persuades, activates, or reassures.

Required order:

1. Run the `humanizer` skill to remove AI-sounding, bloated, or generic copy.
2. Run the `third-grade-copy` skill to rewrite and audit the result for a third-grade reading level.
3. Verify there are zero lies: no made-up numbers, claims, proof, testimonials, guarantees, rankings, integrations, prices, timelines, or capabilities. Check claims against the product source of truth before publishing.
4. Verify the message fits the whole place it appears: the page, flow, audience, offer, brand voice, surrounding copy, and user intent. Do not approve a line just because it is clear in isolation.

Do not apply this rule to code identifiers, logs, API docs, technical docs for developers, exact legal text, database values, or user-generated content unless the user asks. The files under `portfolio/` and `docs/` are developer documentation and are exempt from step 2.

## Working autonomously
- **Poll, don't idle.** When a task, build, test run, or hook is running, actively poll its status and output until it finishes. Don't just sit and wait passively for it to return.
- **Keep going.** When working toward a goal, finishing one chunk of work means moving straight to the next chunk. Don't stop and wait for further input mid-goal — continue until the goal is done or you are genuinely blocked.
