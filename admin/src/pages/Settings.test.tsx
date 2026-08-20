/// <reference types="@testing-library/jest-dom" />
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Unit tests for the pure normalizeOrigins helper
// ---------------------------------------------------------------------------
import { normalizeOrigins } from "@admin/pages/Settings";

describe("normalizeOrigins", () => {
  it("normalizes a bare hostname to https origin", () => {
    const { origins, invalid } = normalizeOrigins("app.example.com");
    expect(origins).toEqual(["https://app.example.com"]);
    expect(invalid).toEqual([]);
  });

  it("strips path from an absolute URL, keeping only the origin", () => {
    const { origins, invalid } = normalizeOrigins("https://app.example.com/some/path?q=1");
    expect(origins).toEqual(["https://app.example.com"]);
    expect(invalid).toEqual([]);
  });

  it("collapses duplicate entries (bare and full url referring to same origin)", () => {
    const { origins, invalid } = normalizeOrigins(
      "app.example.com, https://app.example.com/path, https://app.example.com",
    );
    expect(origins).toEqual(["https://app.example.com"]);
    expect(invalid).toEqual([]);
  });

  it("handles a bare hostname with port", () => {
    const { origins, invalid } = normalizeOrigins("localhost:3000");
    expect(origins).toEqual(["https://localhost:3000"]);
    expect(invalid).toEqual([]);
  });

  it("accepts an explicit http origin", () => {
    const { origins, invalid } = normalizeOrigins("http://staging.example.com");
    expect(origins).toEqual(["http://staging.example.com"]);
    expect(invalid).toEqual([]);
  });

  it("rejects a javascript: URI as invalid", () => {
    const { origins, invalid } = normalizeOrigins("javascript:alert(1)");
    expect(origins).toEqual([]);
    expect(invalid).toEqual(["javascript:alert(1)"]);
  });

  it("rejects an ftp: URI as invalid", () => {
    const { origins, invalid } = normalizeOrigins("ftp://files.example.com");
    expect(origins).toEqual([]);
    expect(invalid).toEqual(["ftp://files.example.com"]);
  });

  it("reports tokens that cannot be parsed at all as invalid", () => {
    const { origins, invalid } = normalizeOrigins("not a url");
    // "not a url" has spaces so URL constructor will throw
    expect(origins).toEqual([]);
    expect(invalid).toContain("not a url");
  });

  it("handles empty string with no tokens", () => {
    const { origins, invalid } = normalizeOrigins("   ");
    expect(origins).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it("handles a mixed valid/invalid list", () => {
    const { origins, invalid } = normalizeOrigins(
      "app.example.com, javascript:evil(), https://good.example.com",
    );
    expect(origins).toEqual(["https://app.example.com", "https://good.example.com"]);
    expect(invalid).toEqual(["javascript:evil()"]);
  });

  // Hardening: silent garbage-transformation cases must be reported as invalid.
  it("rejects a bare userinfo@host token as invalid instead of silently dropping credentials", () => {
    const { origins, invalid } = normalizeOrigins("user:pass@evil.com");
    expect(origins).toEqual([]);
    expect(invalid).toEqual(["user:pass@evil.com"]);
  });

  it("rejects an absolute URL with userinfo as invalid instead of silently dropping credentials", () => {
    const { origins, invalid } = normalizeOrigins("https://user:pass@evil.com");
    expect(origins).toEqual([]);
    expect(invalid).toEqual(["https://user:pass@evil.com"]);
  });

  it("rejects a scheme-relative URL (starting with //) as invalid instead of silently prepending https", () => {
    const { origins, invalid } = normalizeOrigins("//evil.com");
    expect(origins).toEqual([]);
    expect(invalid).toEqual(["//evil.com"]);
  });

  it("rejects mailto: URI as invalid instead of silently extracting an https origin", () => {
    const { origins, invalid } = normalizeOrigins("mailto:a@b.com");
    expect(origins).toEqual([]);
    expect(invalid).toEqual(["mailto:a@b.com"]);
  });

  it("still normalizes legitimate inputs correctly alongside the new rejection rules", () => {
    const { origins, invalid } = normalizeOrigins(
      "https://example.com, app.example.com, example.com:8443",
    );
    expect(origins).toEqual([
      "https://example.com",
      "https://app.example.com",
      "https://example.com:8443",
    ]);
    expect(invalid).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers for the mock product used in component tests
// ---------------------------------------------------------------------------

const MOCK_PRODUCT = {
  id: "prod-1",
  name: "TestProduct",
  slug: "testproduct",
  widget_public_key: "pk_testkey123456789",
  origin_allowlist_json: "[]",
  brand_color: null,
  primary_domain: null,
};

// ---------------------------------------------------------------------------
// Hoist the mutable patch spy so we can inspect calls in individual tests
// ---------------------------------------------------------------------------
const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));

vi.mock("@admin/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@admin/lib/api")>("@admin/lib/api");
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => {
        if (path.startsWith("settings/products")) {
          return Promise.resolve([MOCK_PRODUCT]);
        }
        return Promise.resolve({});
      }),
      post: vi.fn(),
      patch,
      delete: vi.fn(),
      upload: vi.fn(),
    },
  };
});

import { Settings } from "@admin/pages/Settings";

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Settings />
    </QueryClientProvider>,
  );
}

describe("Settings EditDrawer handleSave — origin normalization", () => {
  beforeEach(() => vi.clearAllMocks());

  async function openDrawer() {
    renderSettings();
    // Wait for the table to load and click Edit on our product.
    const editButton = await screen.findByRole("button", { name: /Edit/i });
    await userEvent.click(editButton);
    // Drawer should now be visible.
    return screen.getByRole("dialog", { name: /TestProduct/i });
  }

  it("does NOT call api.patch and shows error for an invalid token", async () => {
    patch.mockResolvedValue(MOCK_PRODUCT);
    await openDrawer();

    const textarea = screen.getByPlaceholderText(/https:\/\/mysite\.com/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "javascript:alert(1)");

    await userEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    // The error message must be visible.
    expect(
      await screen.findByText(/Invalid origin\(s\):/i),
    ).toBeInTheDocument();
    // api.patch must NOT have been called.
    expect(patch).not.toHaveBeenCalled();
  });

  it("calls api.patch with normalized origins for a bare hostname", async () => {
    patch.mockResolvedValue({ ...MOCK_PRODUCT, origin_allowlist_json: '["https://app.example.com"]' });
    await openDrawer();

    const textarea = screen.getByPlaceholderText(/https:\/\/mysite\.com/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "app.example.com");

    await userEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    // api.patch must be called with the https-normalized origin.
    expect(patch).toHaveBeenCalledWith(
      expect.stringContaining("settings/products/prod-1"),
      expect.objectContaining({
        origin_allowlist_json: JSON.stringify(["https://app.example.com"]),
      }),
    );
  });

  it("de-duplicates and normalizes multiple entries before submitting", async () => {
    patch.mockResolvedValue(MOCK_PRODUCT);
    await openDrawer();

    const textarea = screen.getByPlaceholderText(/https:\/\/mysite\.com/i);
    await userEvent.clear(textarea);
    // Provide two tokens that resolve to the same origin plus one unique one.
    await userEvent.type(
      textarea,
      "https://app.example.com/page, app.example.com, https://other.example.com",
    );

    await userEvent.click(screen.getByRole("button", { name: /Save Changes/i }));

    expect(patch).toHaveBeenCalledWith(
      expect.stringContaining("settings/products/prod-1"),
      expect.objectContaining({
        origin_allowlist_json: JSON.stringify([
          "https://app.example.com",
          "https://other.example.com",
        ]),
      }),
    );
  });
});
