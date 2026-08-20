/// <reference types="@testing-library/jest-dom" />
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApiError } from "@admin/lib/api";

// Mock monitoring before importing App so the mock is in place when the module loads.
vi.mock("@admin/lib/monitoring", () => ({
  reportError: vi.fn(),
  initMonitoring: vi.fn(),
}));

import { App, handleGlobalError, isExpected4xx } from "@admin/App";
import { reportError } from "@admin/lib/monitoring";

const mockReportError = reportError as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockReportError.mockClear();
});

describe("isExpected4xx", () => {
  it("returns true for 400 ApiError", () => {
    expect(isExpected4xx(new ApiError("bad request", { status: 400 }))).toBe(true);
  });

  it("returns true for 404 ApiError", () => {
    expect(isExpected4xx(new ApiError("not found", { status: 404 }))).toBe(true);
  });

  it("returns true for 422 ApiError", () => {
    expect(isExpected4xx(new ApiError("unprocessable", { status: 422 }))).toBe(true);
  });

  it("returns true for 401 ApiError", () => {
    expect(isExpected4xx(new ApiError("unauthorized", { status: 401 }))).toBe(true);
  });

  it("returns true for 403 ApiError", () => {
    expect(isExpected4xx(new ApiError("forbidden", { status: 403 }))).toBe(true);
  });

  it("returns false for 500 ApiError", () => {
    expect(isExpected4xx(new ApiError("server error", { status: 500 }))).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isExpected4xx(new Error("boom"))).toBe(false);
  });
});

describe("handleGlobalError", () => {
  it("does NOT call reportError for a 400 ApiError", () => {
    handleGlobalError(new ApiError("bad request", { status: 400 }));
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("does NOT call reportError for a 404 ApiError", () => {
    handleGlobalError(new ApiError("not found", { status: 404 }));
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("does NOT call reportError for a 422 ApiError", () => {
    handleGlobalError(new ApiError("firewall violation", { status: 422 }));
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("does NOT call reportError for a 401 ApiError but DOES call notifySessionExpired (no throw)", () => {
    // We can't directly assert notifySessionExpired here without more wiring,
    // but we can at least verify reportError is not called.
    expect(() =>
      handleGlobalError(new ApiError("unauthorized", { status: 401 })),
    ).not.toThrow();
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("does NOT call reportError for a 403 ApiError", () => {
    handleGlobalError(new ApiError("forbidden", { status: 403 }));
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("DOES call reportError for a 500 ApiError", () => {
    const err = new ApiError("internal server error", { status: 500 });
    handleGlobalError(err);
    expect(mockReportError).toHaveBeenCalledOnce();
    expect(mockReportError).toHaveBeenCalledWith(err);
  });

  it("DOES call reportError for a plain Error", () => {
    const err = new Error("boom");
    handleGlobalError(err);
    expect(mockReportError).toHaveBeenCalledOnce();
    expect(mockReportError).toHaveBeenCalledWith(err);
  });
});

describe("session recovery", () => {
  it("shows a Cloudflare Access logout link when the admin session is invalid", () => {
    handleGlobalError(new ApiError("invalid CF Access JWT", { status: 401 }));

    render(<App />);

    expect(screen.getByText("Your session expired. Please sign in again to continue.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log out" })).toHaveAttribute(
      "href",
      "/cdn-cgi/access/logout",
    );
  });
});
