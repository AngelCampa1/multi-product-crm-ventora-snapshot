import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@admin/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-500",
  secondary:
    "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus-visible:ring-indigo-500",
  danger:
    "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500",
  ghost:
    "bg-transparent text-gray-700 hover:bg-gray-100 focus-visible:ring-indigo-500",
  // icon shares its color treatment with ghost; sizing is overridden below.
  icon:
    "bg-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-indigo-500",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5",
  md: "px-4 py-2 text-sm gap-2",
  lg: "px-6 py-3 text-base gap-2.5",
};

// Square sizing for the circular icon-only variant.
const ICON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 w-7",
  md: "h-9 w-9",
  lg: "h-11 w-11",
};

// rounded-full is canon: every Ventora admin button is a pill.
const BASE_CLASSES =
  "inline-flex items-center justify-center rounded-full font-semibold " +
  "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
  "disabled:opacity-50 disabled:pointer-events-none";

function resolveClasses(
  variant: ButtonVariant,
  size: ButtonSize,
  className?: string,
): string {
  const sizing =
    variant === "icon" ? ICON_SIZE_CLASSES[size] : SIZE_CLASSES[size];
  return cn(BASE_CLASSES, VARIANT_CLASSES[variant], sizing, className);
}

const Spinner = () => (
  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
);

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

export type ButtonProps = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    isLoading?: boolean;
    href?: undefined;
  };

export type ButtonAsLinkProps = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
  };

/**
 * The canonical Ventora admin button. Always a pill (`rounded-full`).
 *
 * Renders a `<button>` by default, or an `<a>` styled identically when `href`
 * is supplied (e.g. "Open Preview" link-as-button). Icon-only buttons should
 * use `variant="icon"` and must pass `aria-label`.
 */
export const Button = forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ButtonProps | ButtonAsLinkProps
>(function Button(props, ref) {
  const {
    variant = "primary",
    size = "md",
    leftIcon,
    rightIcon,
    className,
    children,
    ...rest
  } = props;

  const classes = resolveClasses(variant, size, className);

  if ("href" in props && props.href !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { href, isLoading: _isLoading, ...anchorRest } = rest as AnchorHTMLAttributes<HTMLAnchorElement> & { isLoading?: boolean };
    return (
      <a
        ref={ref as React.Ref<HTMLAnchorElement>}
        href={href}
        className={classes}
        {...anchorRest}
      >
        {leftIcon}
        {children}
        {rightIcon}
      </a>
    );
  }

  const {
    isLoading = false,
    disabled,
    type,
    ...buttonRest
  } = rest as ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean };

  return (
    <button
      ref={ref as React.Ref<HTMLButtonElement>}
      type={type ?? "button"}
      className={classes}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...buttonRest}
    >
      {isLoading ? <Spinner /> : leftIcon}
      {children}
      {!isLoading && rightIcon}
    </button>
  );
});
