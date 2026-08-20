import * as Sentry from "@sentry/react";

function parseSampleRate(value: string | undefined): number {
  if (!value) return 0.1;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.1;

  return Math.min(Math.max(parsed, 0), 1);
}

/**
 * Report an error to Sentry if monitoring is initialized. Safe to call
 * unconditionally — Sentry no-ops when `init` was never run (no DSN).
 */
export function reportError(error: unknown, context?: Record<string, unknown>) {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}

export function initMonitoring() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    sendDefaultPii: false,
    tracesSampleRate: parseSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE),
    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
      }
      return event;
    },
  });
}
