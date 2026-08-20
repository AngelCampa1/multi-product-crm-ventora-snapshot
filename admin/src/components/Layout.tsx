import { Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  BarChart3,
  Users,
  Star,
  MessageSquare,
  Download,
  Settings,
  Loader2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@admin/lib/utils";
import { api } from "@admin/lib/api";

function PageFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-label="Loading">
      <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
    </div>
  );
}

const navItems = [
  { to: "/dashboard", label: "Overview", Icon: BarChart3 },
  { to: "/customers", label: "Customers", Icon: Users },
  { to: "/wall", label: "Wall of Fame", Icon: Star },
  { to: "/feedback", label: "Feedback", Icon: MessageSquare },
  { to: "/reviews", label: "Reviews", Icon: Download },
  { to: "/settings", label: "Settings", Icon: Settings },
] as const;

interface LayoutProps {
  children?: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ email: string }>("me"), staleTime: 5 * 60 * 1000 });

  return (
    <div className="flex min-h-screen bg-slate-100 text-slate-950">
      <a
        href="#main-content"
        className="sr-only z-50 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:rounded-md focus:bg-slate-950 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-slate-400"
      >
        Skip to main content
      </a>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-200 px-5 py-5">
          <span className="text-lg font-semibold tracking-tight text-slate-950">
            Ventora CRM
          </span>
          <p className="mt-1 text-xs font-medium text-slate-500">Customer proof hub</p>
        </div>

        <nav aria-label="Primary" className="flex-1 space-y-1 px-3 py-4">
          {navItems.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-full px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-slate-950 text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto border-t border-slate-200 px-5 py-4">
          <p className="text-xs font-medium text-slate-400">Signed in as</p>
          <p className="truncate text-sm font-medium text-slate-700" title={meQuery.data?.email}>
            {meQuery.data?.email ?? "…"}
          </p>
        </div>
      </aside>

      <main
        id="main-content"
        tabIndex={-1}
        className="w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto focus:outline-none"
      >
        <div className="mx-auto w-full max-w-7xl min-w-0 px-4 py-5 sm:px-6 lg:px-8">
          <div className="mb-5 border-b border-slate-200 pb-3 md:hidden">
            <div className="text-base font-semibold text-slate-950">Ventora CRM</div>
            <nav aria-label="Primary" className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {navItems.map(({ to, label, Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      "inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-sm font-medium",
                      isActive
                        ? "bg-slate-950 text-white"
                        : "bg-white text-slate-600 ring-1 ring-slate-200",
                    )
                  }
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
          <Suspense fallback={<PageFallback />}>{children ?? <Outlet />}</Suspense>
        </div>
      </main>
    </div>
  );
}
