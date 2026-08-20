/**
 * Verifies the deployed Worker is the schema-compatible build before phase 2
 * removes legacy database compatibility, and smokes the public routes that
 * catch asset binding, route partitioning, and widget host mistakes.
 */

import { execSync } from "node:child_process";

const EXPECTED_SCHEMA_COMPAT = 2;
const CRM_ORIGIN = process.env.DEPLOYED_CRM_ORIGIN ?? "https://crm.ventoralabs.com";
const WIDGET_ORIGIN = process.env.DEPLOYED_WIDGET_ORIGIN ?? "https://widgets.ventoralabs.com";
const HEALTH_URL = process.env.DEPLOYED_WORKER_HEALTH_URL ?? `${WIDGET_ORIGIN}/healthz`;
const PRODUCT_ORIGIN = process.env.DEPLOYED_WIDGET_PRODUCT_ORIGIN ?? "https://app.camaudit.io";
const WIDGET_PRODUCT_SLUG = process.env.DEPLOYED_WIDGET_PRODUCT_SLUG ?? "camaudit-v2";

async function readText(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}

async function assertOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} failed: HTTP ${response.status} ${await readText(response)}`);
  }
  return response;
}

async function assertStatus(url: string, expected: number, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== expected) {
    throw new Error(`${url} expected HTTP ${expected}, got ${response.status}: ${await readText(response)}`);
  }
  return response;
}

async function verifyHealth(): Promise<void> {
  const response = await assertOk(HEALTH_URL, { headers: { Accept: "application/json" } });
  const body = await response.json() as { schema_compat?: unknown; service?: unknown };
  if (body.service !== "ventora-crm" || body.schema_compat !== EXPECTED_SCHEMA_COMPAT) {
    throw new Error(`deployed Worker is not schema-compatible: ${JSON.stringify(body)}`);
  }
}

async function verifyAssetsAndRoutePartitioning(): Promise<void> {
  const admin = await fetch(`${CRM_ORIGIN}/admin`, { headers: { Accept: "text/html" }, redirect: "manual" });
  if (admin.status === 200) {
    const adminHtml = await admin.text();
    if (!adminHtml.includes("<!doctype html") && !adminHtml.includes("<div id=\"root\"")) {
      throw new Error("admin SPA did not return the built asset shell");
    }
  } else if (![302, 401, 403].includes(admin.status)) {
    throw new Error(`admin route returned unexpected HTTP ${admin.status}`);
  }

  const widgetHostAdmin = await assertStatus(`${WIDGET_ORIGIN}/admin`, 404, { headers: { Accept: "application/json" } });
  const widgetHostBody = await widgetHostAdmin.json() as unknown;
  if (JSON.stringify(widgetHostBody) !== JSON.stringify({ error: "not found" })) {
    throw new Error(`widget host admin partition returned unexpected body: ${JSON.stringify(widgetHostBody)}`);
  }

  const preview = await fetch(`${CRM_ORIGIN}/preview/camaudit-v2/wall-grid`, { redirect: "manual" });
  if (![200, 302, 401, 403].includes(preview.status)) {
    throw new Error(`preview sandbox returned unexpected HTTP ${preview.status}`);
  }
}

async function verifyWidgetPublicSurface(): Promise<void> {
  const loader = await assertOk(`${WIDGET_ORIGIN}/w/v1.js`, { headers: { Accept: "application/javascript" } });
  const loaderText = await loader.text();
  if (!loaderText.includes("data-api-base") || loaderText.includes("eval(") || loaderText.includes("new Function")) {
    throw new Error("widget loader smoke failed expected loader invariants");
  }

  const widgetKey = widgetPublicKey();
  if (!widgetKey) {
    console.warn(`Skipping widget data smoke: no widget_public_key found for ${WIDGET_PRODUCT_SLUG}.`);
    return;
  }

  const missingOrigin = await assertStatus(`${WIDGET_ORIGIN}/w/data/${encodeURIComponent(widgetKey)}/wall-grid`, 403, {
    headers: { Accept: "application/json" },
  });
  const missingOriginBody = await missingOrigin.json() as { error?: unknown };
  if (missingOriginBody.error !== "origin required") {
    throw new Error(`widget data missing-origin body changed: ${JSON.stringify(missingOriginBody)}`);
  }

  const data = await assertOk(`${WIDGET_ORIGIN}/w/data/${encodeURIComponent(widgetKey)}/wall-grid`, {
    headers: { Accept: "application/json", Origin: PRODUCT_ORIGIN },
  });
  const dataBody = await data.json() as { __html?: unknown; __css?: unknown };
  if (typeof dataBody.__html !== "string" || typeof dataBody.__css !== "string") {
    throw new Error(`widget data did not return rendered payload: ${JSON.stringify(dataBody)}`);
  }
}

function widgetPublicKey(): string | null {
  if (process.env.DEPLOYED_WIDGET_PUBLIC_KEY) return process.env.DEPLOYED_WIDGET_PUBLIC_KEY;
  try {
    const output = execSync(
      `wrangler d1 execute ventora-crm --remote --json --command "SELECT widget_public_key FROM products WHERE slug = '${WIDGET_PRODUCT_SLUG.replace(/'/g, "''")}' LIMIT 1"`,
      { encoding: "utf8" },
    );
    const payload = JSON.parse(output) as Array<{ results?: Array<{ widget_public_key?: string }> }>;
    return payload[0]?.results?.[0]?.widget_public_key ?? null;
  } catch (err) {
    console.warn(`Unable to read deployed widget key: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
  await verifyHealth();
  await verifyAssetsAndRoutePartitioning();
  await verifyWidgetPublicSurface();
  console.log(`Deployed Worker smoke checks passed for ${CRM_ORIGIN} and ${WIDGET_ORIGIN}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
