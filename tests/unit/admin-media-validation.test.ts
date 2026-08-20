import type { D1Database, D1PreparedStatement, R2Bucket } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import mediaRouter from "../../src/routes/admin/media";

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

function makeDb(referenceCount: number, opts: { failRegistryInsert?: boolean } = {}) {
  const statements: BoundStatement[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        sql,
        bindings: [],
        bind: vi.fn(function bind(this: BoundStatement, ...values: unknown[]) {
          this.bindings = values;
          return this;
        }),
        first: vi.fn(async () => ({ count: referenceCount })),
        all: vi.fn(async () => ({ results: [] })),
        raw: vi.fn(),
        run: vi.fn(async function run(this: BoundStatement) {
          if (this.sql.includes("INSERT INTO media_assets") && opts.failRegistryInsert) {
            throw new Error("D1 registry failed");
          }
          if (this.sql.includes("UPDATE media_assets")) {
            return { success: true, meta: { changes: referenceCount > 0 ? 0 : 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        }),
      } as unknown as BoundStatement;
      statements.push(stmt);
      return stmt;
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
  return { db, statements };
}

function makeMediaBucket() {
  return {
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as R2Bucket & { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
}

describe("admin media validation", () => {
  it("rejects image content-types when bytes are not a supported image signature", async () => {
    const media = makeMediaBucket();
    const { db } = makeDb(0);

    const response = await mediaRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: "<html>not an image</html>",
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "file bytes do not match a supported image type" });
    expect(media.put).not.toHaveBeenCalled();
  });

  it("rejects oversized uploads from Content-Length before writing media", async () => {
    const media = makeMediaBucket();
    const { db } = makeDb(0);

    const response = await mediaRouter.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(5 * 1024 * 1024 + 1),
      },
      body: "not read",
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "file exceeds 5MB limit" });
    expect(media.put).not.toHaveBeenCalled();
  });

  it("rejects oversized raw uploads without buffering the full stream", async () => {
    const media = makeMediaBucket();
    const { db } = makeDb(0);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (pulls >= 8) controller.close();
      },
    });

    const response = await mediaRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }, { DB: db, MEDIA: media });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "file exceeds 5MB limit" });
    expect(media.put).not.toHaveBeenCalled();
    expect(pulls).toBeLessThan(8);
  });

  it("rejects multipart uploads without Content-Length before parsing form data", async () => {
    const media = makeMediaBucket();
    const { db } = makeDb(0);

    const response = await mediaRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=test" },
      body: "--test--",
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(411);
    await expect(response.json()).resolves.toEqual({ error: "Content-Length is required for multipart uploads" });
    expect(media.put).not.toHaveBeenCalled();
  });

  it("registers uploaded media in D1 after writing R2", async () => {
    const media = makeMediaBucket();
    const { db, statements } = makeDb(0);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const response = await mediaRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: png,
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(201);
    expect(media.put).toHaveBeenCalledOnce();
    const registryInsert = statements.find((stmt) => stmt.sql.includes("INSERT INTO media_assets"));
    expect(registryInsert?.bindings[1]).toBe("image/png");
    expect(registryInsert?.bindings[2]).toBe(png.byteLength);
  });

  it("deletes uploaded R2 media when D1 registration fails", async () => {
    const media = makeMediaBucket();
    const { db } = makeDb(0, { failRegistryInsert: true });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const response = await mediaRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: png,
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(500);
    expect(media.put).toHaveBeenCalledOnce();
    expect(media.delete).toHaveBeenCalledWith(expect.stringMatching(/^media\/.+\.png$/));
  });

  it("rejects deleting media keys that are still referenced by customers", async () => {
    const media = makeMediaBucket();
    const { db } = makeDb(1);

    const response = await mediaRouter.request("/media/customer-photo.png", {
      method: "DELETE",
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "media key is still referenced by customers",
      code: "MEDIA_IN_USE",
    });
    expect(media.delete).not.toHaveBeenCalled();
  });

  it("marks unreferenced media deleted before deleting the R2 object", async () => {
    const media = makeMediaBucket();
    const { db, statements } = makeDb(0);

    const response = await mediaRouter.request("/media/customer-photo.png", {
      method: "DELETE",
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(204);
    const deletionMark = statements.find((stmt) => stmt.sql.includes("UPDATE media_assets"));
    expect(deletionMark?.sql).toContain("NOT EXISTS");
    expect(deletionMark?.sql).toContain("customers WHERE photo_r2_key");
    expect(media.delete).toHaveBeenCalledWith("media/customer-photo.png");
  });

  it("restores registry state when R2 delete fails after marking media deleted", async () => {
    const media = makeMediaBucket();
    media.delete.mockRejectedValueOnce(new Error("R2 unavailable"));
    const { db, statements } = makeDb(0);

    const response = await mediaRouter.request("/media/customer-photo.png", {
      method: "DELETE",
    }, { DB: db, MEDIA: media });

    expect(response.status).toBe(500);
    expect(statements.some((stmt) => stmt.sql.includes("UPDATE media_assets SET deleted_at = NULL"))).toBe(true);
  });
});
