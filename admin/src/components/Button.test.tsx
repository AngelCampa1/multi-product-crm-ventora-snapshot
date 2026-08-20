/// <reference types="@testing-library/jest-dom" />
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@admin/components/Button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("is always pill-shaped (rounded-full)", () => {
    const { rerender } = render(<Button>X</Button>);
    expect(screen.getByRole("button")).toHaveClass("rounded-full");

    rerender(
      <Button variant="icon" size="lg" aria-label="close">
        X
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveClass("rounded-full");
  });

  it("defaults to type=button", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  describe("variants", () => {
    it("primary applies the filled indigo treatment", () => {
      render(<Button variant="primary">P</Button>);
      expect(screen.getByRole("button")).toHaveClass("bg-indigo-600");
    });

    it("secondary applies a bordered subtle treatment", () => {
      render(<Button variant="secondary">S</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveClass("border");
      expect(btn).toHaveClass("bg-white");
    });

    it("danger applies the red treatment", () => {
      render(<Button variant="danger">D</Button>);
      expect(screen.getByRole("button")).toHaveClass("bg-red-600");
    });

    it("ghost applies a transparent treatment", () => {
      render(<Button variant="ghost">G</Button>);
      expect(screen.getByRole("button")).toHaveClass("bg-transparent");
    });

    it("icon applies square sizing", () => {
      render(
        <Button variant="icon" aria-label="trash">
          T
        </Button>,
      );
      const btn = screen.getByRole("button");
      expect(btn).toHaveClass("h-9");
      expect(btn).toHaveClass("w-9");
    });
  });

  describe("sizes", () => {
    it("sm applies small padding", () => {
      render(<Button size="sm">S</Button>);
      expect(screen.getByRole("button")).toHaveClass("px-3");
    });

    it("md (default) applies medium padding", () => {
      render(<Button>M</Button>);
      expect(screen.getByRole("button")).toHaveClass("px-4");
    });

    it("lg applies large padding", () => {
      render(<Button size="lg">L</Button>);
      expect(screen.getByRole("button")).toHaveClass("px-6");
    });
  });

  describe("disabled / loading", () => {
    it("disabled disables the button", () => {
      render(<Button disabled>D</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
    });

    it("isLoading disables the button and shows a spinner", () => {
      render(<Button isLoading>Saving</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("aria-busy", "true");
      expect(btn.querySelector(".animate-spin")).not.toBeNull();
    });
  });

  describe("onClick", () => {
    it("fires when enabled", async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(<Button onClick={onClick}>Click</Button>);
      await user.click(screen.getByRole("button"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("does not fire when disabled", async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(
        <Button onClick={onClick} disabled>
          Click
        </Button>,
      );
      await user.click(screen.getByRole("button"));
      expect(onClick).not.toHaveBeenCalled();
    });

    it("does not fire when loading", async () => {
      const onClick = vi.fn();
      const user = userEvent.setup();
      render(
        <Button onClick={onClick} isLoading>
          Click
        </Button>,
      );
      await user.click(screen.getByRole("button"));
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("as anchor", () => {
    it("renders an <a> when href is given, styled identically", () => {
      render(
        <Button href="https://example.com" variant="primary">
          Open Preview
        </Button>,
      );
      const link = screen.getByRole("link", { name: "Open Preview" });
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "https://example.com");
      expect(link).toHaveClass("rounded-full");
      expect(link).toHaveClass("bg-indigo-600");
    });

    it("does not leak isLoading onto the <a> DOM node", () => {
      render(
        // Cast to any to allow passing isLoading on the link overload in tests.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <Button href="/x" {...({ isLoading: true } as any)}>
          Link
        </Button>,
      );
      const link = screen.getByRole("link", { name: "Link" });
      expect(link).not.toHaveAttribute("isLoading");
      expect(link).not.toHaveAttribute("isloading");
    });
  });

  describe("icons", () => {
    it("renders leftIcon and rightIcon", () => {
      render(
        <Button
          leftIcon={<span data-testid="left" />}
          rightIcon={<span data-testid="right" />}
        >
          Both
        </Button>,
      );
      expect(screen.getByTestId("left")).toBeInTheDocument();
      expect(screen.getByTestId("right")).toBeInTheDocument();
    });
  });

  describe("ref forwarding", () => {
    it("forwards ref to the button element", () => {
      const ref = createRef<HTMLButtonElement>();
      render(<Button ref={ref}>R</Button>);
      expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    });

    it("forwards ref to the anchor element when href is given", () => {
      const ref = createRef<HTMLAnchorElement>();
      render(
        <Button ref={ref} href="https://example.com">
          R
        </Button>,
      );
      expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
    });
  });
});
