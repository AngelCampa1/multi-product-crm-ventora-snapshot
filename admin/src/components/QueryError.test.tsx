/// <reference types="@testing-library/jest-dom" />
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryError } from "@admin/components/QueryError";
import { ApiError } from "@admin/lib/api";

describe("QueryError", () => {
  it("renders the error message from an ApiError", () => {
    render(
      <QueryError error={new ApiError("could not load", { status: 500 })} onRetry={() => {}} />,
    );
    expect(screen.getByText("could not load")).toBeInTheDocument();
  });

  it("fires onRetry when the Retry button is clicked", async () => {
    const onRetry = vi.fn();
    render(<QueryError error={new Error("boom")} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
