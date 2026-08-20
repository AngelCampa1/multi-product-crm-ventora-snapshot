import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@admin/components/Button";
import { reportError } from "@admin/lib/monitoring";
import { getErrorMessage } from "@admin/lib/api";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere in the tree, reports them to Sentry, and
 * renders a friendly fallback instead of a blank SPA. A full reload is the
 * simplest reliable recovery, so the fallback offers exactly that.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, { componentStack: info.componentStack });
  }

  private handleReload = () => {
    window.location.reload();
  };

  override render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
          <AlertTriangle className="h-10 w-10 text-red-500" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Something went wrong</h1>
            <p className="mt-1 max-w-md text-sm text-gray-500">
              {getErrorMessage(this.state.error)}
            </p>
          </div>
          <Button onClick={this.handleReload}>Reload</Button>
        </div>
      );
    }

    return this.props.children;
  }
}
