import { Hono } from "hono";
import type { Env } from "../../worker";
import { ProductsDB } from "../../db/queries";
import { bustProductWidgets } from "../../lib/cache";

const router = new Hono<{ Bindings: Env }>();
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const HOSTNAME_RE = /^(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function isAbsoluteOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value && url.pathname === "/";
  } catch {
    return false;
  }
}

function isHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

// Products are provisioned exclusively via scripts/seed-products.ts (sourced from the Ventora
// operations repo). There is intentionally no create or delete endpoint — only read + patch (settings).
router.get("/products", async (c) => {
  const products = await ProductsDB.list(c.env.DB);
  return c.json(
    products.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      widget_public_key: p.widget_public_key,
      origin_allowlist_json: p.origin_allowlist_json,
      brand_color: p.brand_color,
      primary_domain: p.primary_domain,
      firewall_group: p.firewall_group,
      created_at: p.created_at,
    })),
  );
});

router.patch("/products/:id", async (c) => {
  const id = c.req.param("id");
  const product = await ProductsDB.getById(c.env.DB, id);
  if (!product) return c.json({ error: "product not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "settings patch body must be a JSON object" }, 400);
  }

  const input = body as Record<string, unknown>;
  const patch: Partial<{
    brand_color: string | null;
    primary_domain: string | null;
    origin_allowlist_json: string;
  }> = {};

  if ("brand_color" in input) {
    const v = input["brand_color"];
    if (v === null || v === undefined || v === "") {
      patch.brand_color = null;
    } else if (typeof v === "string" && HEX_COLOR_RE.test(v)) {
      patch.brand_color = v.toLowerCase();
    } else {
      return c.json({ error: "brand_color must be a hex color like #2563eb" }, 400);
    }
  }
  if ("primary_domain" in input) {
    const v = input["primary_domain"];
    if (v === null || v === undefined || v === "") {
      patch.primary_domain = null;
    } else if (typeof v === "string" && isHostname(v)) {
      patch.primary_domain = v.toLowerCase();
    } else {
      return c.json({ error: "primary_domain must be a hostname without protocol or path" }, 400);
    }
  }
  if ("origin_allowlist_json" in input) {
    const v = input["origin_allowlist_json"];
    if (typeof v !== "string") {
      return c.json({ error: "origin_allowlist_json must be a JSON string" }, 400);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      return c.json({ error: "origin_allowlist_json is not valid JSON" }, 400);
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      return c.json({ error: "origin_allowlist_json must be a JSON array of strings" }, 400);
    }
    if (!parsed.every(isAbsoluteOrigin)) {
      return c.json({ error: "origin_allowlist_json entries must be absolute URL origins" }, 400);
    }
    patch.origin_allowlist_json = JSON.stringify(parsed);
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no valid fields to update" }, 400);
  }

  await c.env.DB
    .prepare(
      `UPDATE products SET ${Object.keys(patch)
        .map((k) => `${k} = ?`)
        .join(", ")} WHERE id = ?`,
    )
    .bind(...Object.values(patch), id)
    .run();

  const updated = await ProductsDB.getById(c.env.DB, id);
  // brand_color is baked into widget HTML and origin_allowlist gates the loader;
  // both shift widget output, so bust caches whenever either changes.
  if ("brand_color" in patch || "origin_allowlist_json" in patch) {
    await bustProductWidgets(product.slug);
  }
  return c.json(updated);
});

router.post("/products/:id/regenerate-key", async (c) => {
  const id = c.req.param("id");
  const product = await ProductsDB.getById(c.env.DB, id);
  if (!product) return c.json({ error: "product not found" }, 404);

  const newKey = `wk_${[...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  await c.env.DB
    .prepare("UPDATE products SET widget_public_key = ? WHERE id = ?")
    .bind(newKey, id)
    .run();
  await bustProductWidgets(product.slug);

  return c.json({ widget_public_key: newKey });
});

export default router;
