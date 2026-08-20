import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, getErrorMessage } from "@admin/lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApiError", () => {
  it("is a real Error with status, code, and body", () => {
    const err = new ApiError("nope", {
      status: 422,
      code: "FIREWALL_VIOLATION",
      body: { error: "nope", code: "FIREWALL_VIOLATION" },
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe("ApiError");
    expect(err.message).toBe("nope");
    expect(err.status).toBe(422);
    expect(err.code).toBe("FIREWALL_VIOLATION");
    expect(err.body).toEqual({ error: "nope", code: "FIREWALL_VIOLATION" });
    expect(typeof err.stack).toBe("string");
  });

  it("allows an undefined code", () => {
    const err = new ApiError("boom", { status: 500 });
    expect(err.code).toBeUndefined();
  });
});

describe("getErrorMessage", () => {
  it("reads an ApiError message", () => {
    expect(getErrorMessage(new ApiError("firewall", { status: 422 }))).toBe("firewall");
  });

  it("reads a plain Error message", () => {
    expect(getErrorMessage(new Error("plain"))).toBe("plain");
  });

  it("passes strings through", () => {
    expect(getErrorMessage("just a string")).toBe("just a string");
  });

  it("reads legacy { error } objects", () => {
    expect(getErrorMessage({ error: "legacy" })).toBe("legacy");
  });

  it("falls back for unknown shapes", () => {
    expect(getErrorMessage(null)).toBe("Something went wrong.");
    expect(getErrorMessage({})).toBe("Something went wrong.");
  });
});

describe("api fetch headers", () => {
  it("marks GET requests as XMLHttpRequest so Cloudflare Access returns 401 for expired sessions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await api.get("me");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/me", {
      method: "GET",
      headers: { "X-Requested-With": "XMLHttpRequest" },
      body: undefined,
    });
  });

  it("keeps the Access AJAX marker alongside JSON mutation headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await api.post("customers", { name: "Acme" });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/customers", {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-Ventora-CSRF": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Acme" }),
    });
  });

  it("marks uploads as XMLHttpRequest without forcing a JSON content type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    await api.upload("media/avatar", file);

    expect(fetchMock.mock.calls[0]).toBeDefined();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-Ventora-CSRF": "1",
      },
    });
    expect((init as RequestInit).headers).not.toHaveProperty("Content-Type");
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });
});
