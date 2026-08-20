/// <reference types="@testing-library/jest-dom" />
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the API layer so the page renders without real network calls.
vi.mock("@admin/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@admin/lib/api")>("@admin/lib/api");
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => {
        if (path.startsWith("settings/products")) return Promise.resolve([]);
        if (path.startsWith("customers")) return Promise.resolve({ customers: [] });
        // testimonials list
        return Promise.resolve({ testimonials: [], total: 0 });
      }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      upload: vi.fn(),
    },
  };
});

import { WallOfFame } from "@admin/pages/WallOfFame";

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <WallOfFame />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function tabButton(name: RegExp) {
  return screen.getByRole("button", { name });
}

describe("WallOfFame tab/URL sync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reflects ?status=approved from the URL on mount", async () => {
    renderAt("/wall?status=approved");
    // The approved tab is selected => its empty-state copy is shown.
    expect(
      await screen.findByText(/No approved testimonials yet/i),
    ).toBeInTheDocument();
  });

  it("defaults to the pending tab when no status param is present", async () => {
    renderAt("/wall");
    expect(await screen.findByText(/No pending testimonials/i)).toBeInTheDocument();
  });

  it("switches tabs when the tab button is clicked", async () => {
    renderAt("/wall");
    expect(await screen.findByText(/No pending testimonials/i)).toBeInTheDocument();

    await userEvent.click(tabButton(/Approved/i));
    expect(
      await screen.findByText(/No approved testimonials yet/i),
    ).toBeInTheDocument();
  });
});
