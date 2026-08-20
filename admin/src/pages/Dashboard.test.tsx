/// <reference types="@testing-library/jest-dom" />
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@admin/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@admin/lib/api")>("@admin/lib/api");
  return {
    ...actual,
    api: {
      get: vi.fn(() =>
        Promise.resolve({
          customers: { total: 0, lead: 0, active: 0, churned: 0, champion: 0 },
          testimonials: { approved: 0, pending: 0 },
          feedback: { total: 0 },
          reviews: { total: 0 },
          products: [],
          pending_testimonials: [],
        }),
      ),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      upload: vi.fn(),
    },
  };
});

import { Dashboard } from "@admin/pages/Dashboard";
import { api } from "@admin/lib/api";

function renderDashboard(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Dashboard summary query — refetchOnMount:always", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refetches dashboard-summary on every mount even when data is fresh (staleTime high)", async () => {
    // Build a QueryClient with a very high staleTime so that without
    // refetchOnMount:"always" the second render would NOT call api.get again.
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 60_000,
          retry: false,
        },
      },
    });

    const apiGet = vi.mocked(api.get);

    // First mount — fetches once.
    const { unmount } = renderDashboard(qc);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));

    // Unmount (simulates navigating away).
    unmount();

    // Second mount using the SAME QueryClient (data is still "fresh" per staleTime).
    renderDashboard(qc);
    // refetchOnMount:"always" must force a second fetch despite fresh cache.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });
});
