import { Hono } from "hono";
import type { Env } from "../../worker";

const router = new Hono<{ Bindings: Env }>();

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function extFor(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

function detectImageMime(bytes: ArrayBuffer): string | null {
  const b = new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) return "image/png";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) return "image/webp";
  if (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  ) return "image/gif";
  return null;
}

async function readRequestBodyBounded(request: Request): Promise<ArrayBuffer | Response> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  let reading = true;
  while (reading) {
    const result = await reader.read();
    if (result.done) {
      reading = false;
      continue;
    }
    const value = result.value;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return new Response(JSON.stringify({ error: "file exceeds 5MB limit" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

router.post("/", async (c) => {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  const contentLength = c.req.header("Content-Length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    return c.json({ error: "file exceeds 5MB limit" }, 413);
  }

  let bytes: ArrayBuffer;
  let mime: string;

  if (contentType.startsWith("multipart/form-data")) {
    if (!contentLength) {
      return c.json({ error: "Content-Length is required for multipart uploads" }, 411);
    }
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "file field is required" }, 400);
    }
    mime = file.type;
    bytes = await file.arrayBuffer();
  } else {
    mime = (contentType.split(";")[0] ?? "").trim();
    const boundedBody = await readRequestBodyBounded(c.req.raw);
    if (boundedBody instanceof Response) return boundedBody;
    bytes = boundedBody;
  }

  if (!ALLOWED_TYPES.has(mime)) {
    return c.json({ error: `unsupported content-type: ${mime}` }, 415);
  }
  if (bytes.byteLength === 0) {
    return c.json({ error: "empty body" }, 400);
  }
  if (bytes.byteLength > MAX_BYTES) {
    return c.json({ error: "file exceeds 5MB limit" }, 413);
  }
  if (detectImageMime(bytes) !== mime) {
    return c.json({ error: "file bytes do not match a supported image type" }, 415);
  }

  const key = `media/${crypto.randomUUID()}.${extFor(mime)}`;
  await c.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: mime },
  });
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO media_assets (key, content_type, size_bytes, created_at, deleted_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(key) DO UPDATE SET
         content_type = excluded.content_type,
         size_bytes = excluded.size_bytes,
         created_at = excluded.created_at,
         deleted_at = NULL`,
      )
      .bind(key, mime, bytes.byteLength, new Date().toISOString())
      .run();
  } catch (err) {
    try {
      await c.env.MEDIA.delete(key);
    } catch {
      // Best-effort cleanup; preserve the D1 failure as the primary error.
    }
    throw err;
  }

  return c.json({ key, content_type: mime, size: bytes.byteLength }, 201);
});

router.delete("/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (!key.startsWith("media/")) {
    return c.json({ error: "invalid key" }, 400);
  }
  const result = await c.env.DB
    .prepare(
      `UPDATE media_assets
          SET deleted_at = ?
        WHERE key = ?
          AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM customers WHERE photo_r2_key = ?
          )`,
    )
    .bind(new Date().toISOString(), key, key)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    const reference = await c.env.DB
      .prepare("SELECT COUNT(*) as count FROM customers WHERE photo_r2_key = ?")
      .bind(key)
      .first<{ count: number }>();
    if ((reference?.count ?? 0) > 0) {
      return c.json({ error: "media key is still referenced by customers", code: "MEDIA_IN_USE" }, 409);
    }
    return c.json({ error: "media key not found" }, 404);
  }
  try {
    await c.env.MEDIA.delete(key);
  } catch (err) {
    await c.env.DB
      .prepare("UPDATE media_assets SET deleted_at = NULL WHERE key = ?")
      .bind(key)
      .run();
    throw err;
  }
  return c.body(null, 204);
});

export default router;
