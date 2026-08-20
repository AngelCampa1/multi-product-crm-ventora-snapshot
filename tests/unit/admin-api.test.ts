import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../admin/src/lib/api";

describe("admin api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats successful 204 responses as empty bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.delete("feedback/abc123")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/feedback/abc123", {
      method: "DELETE",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-Ventora-CSRF": "1",
      },
      body: undefined,
    });
  });
});
