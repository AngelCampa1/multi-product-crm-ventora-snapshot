import { lazy, useSyncExternalStore } from "react";
import { createBrowserRouter, RouterProvider, Navigate, Link } from "react-router-dom";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { Layout } from "@admin/components/Layout";
import { ApiError } from "@admin/lib/api";
import { reportError } from "@admin/lib/monitoring";

// Route-level code splitting: the shell (nav + chrome) ships in the entry
// bundle; each page is fetched on first visit. Keeps first paint of the
// default Overview route from parsing every other page's code. The pages
// resolve under Layout's <Suspense> boundary.
const Dashboard = lazy(() =>
  import("@admin/pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const Customers = lazy(() =>
  import("@admin/pages/Customers").then((m) => ({ default: m.Customers })),
);
const WallOfFame = lazy(() =>
  import("@admin/pages/WallOfFame").then((m) => ({ default: m.WallOfFame })),
);
const Feedback = lazy(() =>
  import("@admin/pages/Feedback").then((m) => ({ default: m.Feedback })),
);
const Reviews = lazy(() =>
  import("@admin/pages/Reviews").then((m) => ({ default: m.Reviews })),
);
const Settings = lazy(() =>
  import("@admin/pages/Settings").then((m) => ({ default: m.Settings })),
);

// ---------------------------------------------------------------------------
// Session-expiry: a tiny global store so any query/mutation error can flip the
// app into a "session expired" notice without a router-auth rework.
// ---------------------------------------------------------------------------

let sessionExpired = false;
const sessionListeners = new Set<() => void>();

function notifySessionExpired() {
  if (sessionExpired) return;
  sessionExpired = true;
  for (const listener of sessionListeners) listener();
}

function subscribeSession(listener: () => void) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function useSessionExpired() {
  return useSyncExternalStore(
    subscribeSession,
    () => sessionExpired,
    () => sessionExpired,
  );
}

function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** 4xx errors are expected, user-facing-handled responses — not exceptions. */
export function isExpected4xx(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

export function handleGlobalError(error: unknown) {
  if (!isExpected4xx(error)) reportError(error);
  if (isAuthError(error)) notifySessionExpired();
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't hammer the backend on client errors (4xx are not transient).
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
  queryCache: new QueryCache({ onError: handleGlobalError }),
  mutationCache: new MutationCache({ onError: handleGlobalError }),
});

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
        <Compass className="h-6 w-6 text-slate-500" />
      </div>
      <h1 className="mt-4 text-lg font-semibold text-slate-950">This page doesn’t exist</h1>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        The page you’re looking for may have moved or never existed. Let’s get you back on track.
      </p>
      <Link
        to="/dashboard"
        className="mt-5 inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
      >
        Back to Overview
      </Link>
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate to="/dashboard" replace />,
  },
  // `/admin` is the URL referenced in deploy docs and CF Access; keep it a valid
  // entry point so the documented link never dead-ends.
  {
    path: "/admin",
    element: <Navigate to="/dashboard" replace />,
  },
  {
    path: "/admin/*",
    element: <Navigate to="/dashboard" replace />,
  },
  {
    element: <Layout />,
    children: [
      { path: "/dashboard", element: <Dashboard /> },
      { path: "/customers", element: <Customers /> },
      { path: "/wall", element: <WallOfFame /> },
      { path: "/feedback", element: <Feedback /> },
      { path: "/reviews", element: <Reviews /> },
      { path: "/settings", element: <Settings /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

function SessionExpiredNotice() {
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-amber-500 px-4 py-2.5 text-sm font-medium text-amber-950 shadow-md">
      <span>Your session expired. Please sign in again to continue.</span>
      <a
        href="/cdn-cgi/access/logout"
        className="rounded-full bg-amber-950/10 px-3 py-1 font-semibold hover:bg-amber-950/20"
      >
        Log out
      </a>
    </div>
  );
}

export function App() {
  const expired = useSessionExpired();

  return (
    <QueryClientProvider client={queryClient}>
      {expired && <SessionExpiredNotice />}
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
