import { useEffect, useRef, type MouseEvent, type RefObject } from "react";

/**
 * Shared modal/drawer dismissal behavior for consistency across admin overlays.
 *
 * Given an `onClose`, this:
 * - registers an Escape keydown listener (cleaned up on unmount / when onClose changes),
 * - returns a backdrop `onClick` handler that fires `onClose` ONLY when the click
 *   target is the backdrop element itself (so clicks bubbling up from inner content
 *   don't accidentally close the dialog), and
 * - returns a ref to attach to the dialog panel; on mount it focuses the panel
 *   (or its first focusable child) so keyboard users land inside the overlay.
 *
 * Full focus-trapping is intentionally out of scope.
 *
 * When multiple overlay instances are mounted simultaneously (e.g. a ConfirmDialog
 * rendered on top of a drawer), only the most-recently-mounted instance responds to
 * Escape. Each instance pushes a unique token onto a module-level stack on mount and
 * removes it on cleanup; the keydown handler fires `onClose` only when its own token
 * is at the top of that stack.
 */

// Module-level stack of active dismiss tokens (most-recently mounted is last).
const _dismissStack: symbol[] = [];

let _counter = 0;

export function useModalDismiss<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null);

  // Stable per-instance token, created exactly once per mount (lazy ref init).
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) {
    tokenRef.current = Symbol(`modal-${++_counter}`);
  }

  // Keep onClose fresh without affecting the mount-once effect below.
  // Reading onCloseRef.current in the keydown handler always sees the latest callback.
  const onCloseRef = useRef<() => void>(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Mount-once effect: push token onto the stack and register the keydown listener.
  // Empty deps [] guarantees the token is pushed exactly once and removed exactly once,
  // regardless of how many times the parent re-renders with a new onClose identity.
  useEffect(() => {
    const token = tokenRef.current as symbol;
    _dismissStack.push(token);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        // Only the topmost (last) entry in the stack should close.
        if (_dismissStack[_dismissStack.length - 1] === token) {
          onCloseRef.current();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const idx = _dismissStack.lastIndexOf(token);
      if (idx !== -1) {
        _dismissStack.splice(idx, 1);
      }
    };
  }, []);

  // Initial focus: prefer the dialog's first focusable element, else the panel itself.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const focusable = node.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? node).focus();
  }, []);

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onCloseRef.current();
  }

  return { dialogRef: dialogRef as RefObject<T>, onBackdropClick };
}
