/// <reference types="@testing-library/jest-dom" />
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRODUCT = {
  id: "prod-1",
  slug: "grantpipe",
  name: "GrantPipe",
  brand_color: null,
  primary_domain: null,
  widget_public_key: "pk_test",
  origin_allowlist_json: "[]",
  firewall_group: null,
  created_at: "2024-01-01T00:00:00Z",
};

const CUSTOMER = {
  id: "cust-1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  photo_r2_key: null,
  company: "Acme",
  role: "Engineer",
  twitter: null,
  linkedin: null,
  website: null,
  lifecycle: "active" as const,
  notes: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
};

const CUSTOMER_DETAIL = {
  customer: CUSTOMER,
  products: [PRODUCT],
  testimonials: [],
  feedback: [],
  reviews: [],
};

// ---------------------------------------------------------------------------
// API mock — hoisted so vi.mock can reference the stubs
// ---------------------------------------------------------------------------

const { apiGet, apiDelete, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock("@admin/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@admin/lib/api")>("@admin/lib/api");
  return {
    ...actual,
    api: {
      get: apiGet,
      post: apiPost,
      patch: vi.fn(),
      delete: apiDelete,
      upload: vi.fn(),
    },
  };
});

import { Customers } from "@admin/pages/Customers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <Customers />
    </QueryClientProvider>,
  );
}

function setupDefaultMocks() {
  apiGet.mockImplementation((path: string) => {
    // products list used by the page-level query
    if (path.startsWith("settings/products")) {
      return Promise.resolve([PRODUCT]);
    }
    // customer list
    if (path === `customers?limit=50&offset=0`) {
      return Promise.resolve({
        customers: [CUSTOMER],
        total: 1,
      });
    }
    // customer detail (opened when a row is clicked)
    if (path === `customers/cust-1`) {
      return Promise.resolve(CUSTOMER_DETAIL);
    }
    return Promise.resolve({});
  });

  apiDelete.mockResolvedValue({});
  apiPost.mockResolvedValue({ linked: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Customers — unlink button accessibility (C1+A1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("renders the unlink control with an accessible aria-label for the product name", async () => {
    const qc = makeQc();
    renderPage(qc);

    // Click the customer row to open the detail panel.
    const row = await screen.findByText("Ada Lovelace");
    await userEvent.click(row);

    // The linked product chip should render an unlink button queryable by role + accessible name.
    const unlinkBtn = await screen.findByRole("button", {
      name: /unlink grantpipe/i,
    });
    expect(unlinkBtn).toBeInTheDocument();
    expect(unlinkBtn).toHaveAttribute("aria-label", "Unlink GrantPipe");
  });
});

describe("Customers — link/unlink invalidates ['customers'] list (C3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("invalidates both ['customer', id] and ['customers'] after unlinking a product", async () => {
    const qc = makeQc();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    renderPage(qc);

    // Open the detail panel.
    const row = await screen.findByText("Ada Lovelace");
    await userEvent.click(row);

    // Click the unlink button.
    const unlinkBtn = await screen.findByRole("button", {
      name: /unlink grantpipe/i,
    });
    await userEvent.click(unlinkBtn);

    // Wait for the mutation to settle.
    await screen.findByRole("button", { name: /unlink grantpipe/i });

    const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(["customer", "cust-1"]);
    expect(keys).toContainEqual(["customers"]);
  });

  it("invalidates both ['customer', id] and ['customers'] after linking a product", async () => {
    // Return a customer with NO linked products so the select is visible.
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith("settings/products")) {
        return Promise.resolve([PRODUCT]);
      }
      if (path === `customers?limit=50&offset=0`) {
        return Promise.resolve({ customers: [CUSTOMER], total: 1 });
      }
      if (path === `customers/cust-1`) {
        return Promise.resolve({ ...CUSTOMER_DETAIL, products: [] });
      }
      return Promise.resolve({});
    });

    const qc = makeQc();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    renderPage(qc);

    // Open the detail panel.
    const row = await screen.findByText("Ada Lovelace");
    await userEvent.click(row);

    // The "+ Add product" select should appear inside the detail dialog; choose the product.
    const dialog = await screen.findByRole("dialog", { name: /Customer detail/i });
    const select = await within(dialog).findByRole("combobox");
    await userEvent.selectOptions(select, "GrantPipe");

    // Wait for mutation to settle — re-query for the detail panel label as anchor.
    await screen.findByText(/Linked Products/i);

    const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(["customer", "cust-1"]);
    expect(keys).toContainEqual(["customers"]);
  });
});
