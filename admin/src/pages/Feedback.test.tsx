/// <reference types="@testing-library/jest-dom" />
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ApiError } from "@admin/lib/api";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@admin/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@admin/lib/api")>("@admin/lib/api");
  return {
    ...actual,
    api: {
      get: vi.fn((path: string) => {
        if (path.startsWith("settings/products")) {
          return Promise.resolve([{ id: "p1", name: "CAMAudit", slug: "camaudit" }]);
        }
        if (path.startsWith("customers")) return Promise.resolve({ customers: [], total: 0 });
        if (path.startsWith("feedback")) return Promise.resolve({ items: [], total: 0 });
        return Promise.resolve({});
      }),
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      upload: vi.fn(),
    },
  };
});

import { Feedback } from "@admin/pages/Feedback";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Feedback />
    </QueryClientProvider>,
  );
}

describe("Feedback AddModal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("surfaces a server error when the create POST fails", async () => {
    post.mockRejectedValueOnce(
      new ApiError("Firewall violation: opposite side of CRE deal", {
        status: 422,
        code: "FIREWALL_VIOLATION",
      }),
    );

    renderPage();

    // Open the Add Feedback modal.
    await userEvent.click(await screen.findByRole("button", { name: /Add Item/i }));

    const dialog = await screen.findByRole("dialog", { name: /Add Feedback/i });
    await userEvent.type(
      await screen.findByPlaceholderText(/Short description of the feedback/i),
      "Needs dark mode",
    );

    // Submit (there are two "Add Item" buttons — use the submit one inside the dialog).
    await userEvent.click(within(dialog).getByRole("button", { name: /Add Item/i }));

    // The error message from the server is shown and the modal stays open.
    expect(
      await screen.findByText(/Firewall violation: opposite side of CRE deal/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /Add Feedback/i })).toBeInTheDocument();
  });
});
