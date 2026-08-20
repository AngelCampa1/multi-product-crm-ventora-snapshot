import { AlertCircle } from "lucide-react";
import { Button } from "@admin/components/Button";
import { getErrorMessage } from "@admin/lib/api";
import { cn } from "@admin/lib/utils";

interface QueryErrorProps {
  error: unknown;
  onRetry: () => void;
  className?: string;
}

/**
 * Inline failure state for a `useQuery` that returned `isError`. Distinguishes a
 * failed fetch from a genuine empty state and gives the user a one-click retry.
 */
export function QueryError({ error, onRetry, className }: QueryErrorProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-10 text-center",
        className,
      )}
    >
      <AlertCircle className="h-8 w-8 text-red-500" aria-hidden="true" />
      <p className="max-w-md text-sm text-red-700">{getErrorMessage(error)}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
