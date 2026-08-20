import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Accessibility plumbing for a modal/drawer:
 *  - Escape closes it.
 *  - Body scroll is locked while open.
 *  - When a `dialogRef` is supplied, focus moves into the dialog on open, Tab is
 *    trapped within it, and focus returns to the previously-focused element on close.
 *
 * Pair with `role="dialog" aria-modal="true"` (+ `aria-labelledby`/`aria-label`)
 * on the same element the ref points at.
 */
export function useModalClose(
  onClose: () => void,
  dialogRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef?.current) {
        const items = focusable(dialogRef.current);
        if (items.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus into the dialog (first focusable, else the dialog itself).
    if (dialogRef?.current) {
      const items = focusable(dialogRef.current);
      const target = items[0] ?? dialogRef.current;
      // Defer so it runs after the dialog has painted.
      requestAnimationFrame(() => target.focus());
    }

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to whatever was focused before the dialog opened.
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [onClose, dialogRef]);
}
