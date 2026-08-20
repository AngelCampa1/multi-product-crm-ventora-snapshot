/// <reference types="@testing-library/jest-dom" />
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalDismiss } from "@admin/lib/useModalDismiss";

function Harness({ onClose }: { onClose: () => void }) {
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);
  return (
    <div>
      <div data-testid="backdrop" onClick={onBackdropClick} />
      <div ref={dialogRef} tabIndex={-1} role="dialog">
        <button>Inside</button>
      </div>
    </div>
  );
}

// A harness whose onClose can be swapped from the outside via props.
function SwappableHarness({ onClose }: { onClose: () => void }) {
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);
  return (
    <div>
      <div data-testid="backdrop-swappable" onClick={onBackdropClick} />
      <div ref={dialogRef} tabIndex={-1} role="dialog" data-testid="dialog-swappable">
        <button>Swappable Inside</button>
      </div>
    </div>
  );
}

describe("useModalDismiss", () => {
  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("removes the Escape listener on unmount", async () => {
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    unmount();

    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose only when the click target is the backdrop itself", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    // Clicking inner content must NOT close.
    await userEvent.click(screen.getByText("Inside"));
    expect(onClose).not.toHaveBeenCalled();

    // Clicking the backdrop element itself closes.
    await userEvent.click(screen.getByTestId("backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the first focusable element on mount", () => {
    render(<Harness onClose={() => {}} />);
    expect(screen.getByText("Inside")).toHaveFocus();
  });

  it("only closes the topmost overlay on Escape; after that unmounts, the next one closes", async () => {
    const onClose1 = vi.fn();
    const onClose2 = vi.fn();

    // Mount first (bottom) instance.
    const { unmount: unmount1 } = render(<Harness onClose={onClose1} />);
    // Mount second (top) instance on top.
    const { unmount: unmount2 } = render(<Harness onClose={onClose2} />);

    // Escape should only fire onClose2 (topmost).
    await userEvent.keyboard("{Escape}");
    expect(onClose2).toHaveBeenCalledTimes(1);
    expect(onClose1).not.toHaveBeenCalled();

    // Simulate the topmost overlay closing — unmount it.
    unmount2();

    // Now Escape should only fire onClose1 (now topmost).
    await userEvent.keyboard("{Escape}");
    expect(onClose1).toHaveBeenCalledTimes(1);
    // onClose2 should still only have been called once (not again).
    expect(onClose2).toHaveBeenCalledTimes(1);

    unmount1();
  });

  it("REGRESSION: re-rendering instance A with a new onClose identity does not reorder the stack above instance B", async () => {
    // This test guards against the bug where the Escape effect had [onClose] deps:
    // re-rendering A with a new onClose reference would teardown+re-setup A's effect,
    // moving A's token to the TOP of the stack so Escape would wrongly close A instead of B.

    const onCloseA1 = vi.fn();
    const onCloseA2 = vi.fn(); // Different function identity, same logical purpose.
    const onCloseB = vi.fn();

    // Wrapper so we can re-render A with a different onClose prop.
    function WrapperA({ onClose }: { onClose: () => void }) {
      return <SwappableHarness onClose={onClose} />;
    }

    // Mount A (bottom) with onCloseA1.
    const { rerender: rerenderA, unmount: unmountA } = render(<WrapperA onClose={onCloseA1} />);
    // Mount B (top) with onCloseB.
    const { unmount: unmountB } = render(<Harness onClose={onCloseB} />);

    // Re-render A with a DIFFERENT onClose function identity.
    // Under the old [onClose] deps this would splice A's token out and re-push it to
    // the top, making A appear to be the topmost overlay.
    act(() => {
      rerenderA(<WrapperA onClose={onCloseA2} />);
    });

    // B is still the topmost overlay — Escape must call B's current onClose, not A's.
    await userEvent.keyboard("{Escape}");
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA1).not.toHaveBeenCalled();
    expect(onCloseA2).not.toHaveBeenCalled();

    unmountB();
    unmountA();
  });

  it("StrictMode: single instance fires onClose exactly once on Escape", async () => {
    // React StrictMode double-invokes effects (mount → cleanup → mount) in development.
    // This verifies the stack stays balanced and the listener is registered correctly
    // after the double-invoke, so Escape fires exactly once.
    const onClose = vi.fn();

    render(
      <React.StrictMode>
        <Harness onClose={onClose} />
      </React.StrictMode>,
    );

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
