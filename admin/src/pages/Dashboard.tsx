import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  Download,
  Inbox,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Star,
  Users,
} from "lucide-react";
import { api } from "@admin/lib/api";
import { QueryError } from "@admin/components/QueryError";
import { cn } from "@admin/lib/utils";

interface Product {
  id: string;
  slug: string;
  name: string;
  brand_color: string | null;
  primary_domain: string | null;
  widget_public_key: string;
  origin_allowlist_json: string;
  firewall_group: string | null;
  feedback_count: number;
  review_count: number;
}

interface Testimonial {
  id: string;
  customer_name: string | null;
  quote: string;
  approved: number;
  featured: number;
  created_at: string;
}

interface DashboardSummary {
  customers: {
    total: number;
    lead: number;
    active: number;
    churned: number;
    champion: number;
  };
  testimonials: {
    approved: number;
    pending: number;
  };
  feedback: {
    total: number;
  };
  reviews: {
    total: number;
  };
  products: Product[];
  pending_testimonials: Testimonial[];
}

function parseOriginCount(json: string): number {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function StatCard({
  label,
  value,
  detail,
  Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  Icon: React.ElementType;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{value}</p>
        </div>
        <div className="rounded-md bg-slate-100 p-2 text-slate-700">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-3 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

function ActionCard({
  to,
  title,
  detail,
  Icon,
}: {
  to: string;
  title: string;
  detail: string;
  Icon: React.ElementType;
}) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow-md"
    >
      <div className="rounded-md bg-slate-950 p-2 text-white">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="font-semibold text-slate-950">{title}</p>
          <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-slate-700" />
        </div>
        <p className="mt-1 text-sm leading-5 text-slate-500">{detail}</p>
      </div>
    </Link>
  );
}

export function Dashboard() {
  const summaryQuery = useQuery<DashboardSummary>({
    queryKey: ["dashboard-summary"],
    queryFn: () => api.get<DashboardSummary>("dashboard"),
    refetchOnMount: "always",
  });

  const summary = summaryQuery.data;
  if (summaryQuery.isError) {
    return (
      <QueryError error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
    );
  }
  const products = summary?.products ?? [];
  const pendingTestimonials = summary?.pending_testimonials ?? [];
  const configuredProducts = products.filter(
    (product) => product.primary_domain && parseOriginCount(product.origin_allowlist_json) > 0,
  ).length;

  const productRows = products.map((product) => {
    const originCount = parseOriginCount(product.origin_allowlist_json);
    const isConfigured = Boolean(product.primary_domain) && originCount > 0;

    return {
      ...product,
      originCount,
      isConfigured,
    };
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Overview</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Track customer proof, review intake, product embeds, and pending Wall of Fame work.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/customers"
            className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
          >
            <Users className="h-4 w-4" />
            Add customer
          </Link>
          <Link
            to="/wall"
            className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            <Star className="h-4 w-4" />
            Review testimonials
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Customers"
          value={summary?.customers.total ?? "—"}
          detail={`${summary?.customers.active ?? 0} active, ${summary?.customers.champion ?? 0} champion`}
          Icon={Users}
        />
        <StatCard
          label="Testimonials"
          value={summary?.testimonials.approved ?? "—"}
          detail={`${summary?.testimonials.pending ?? 0} pending approval`}
          Icon={Sparkles}
        />
        <StatCard
          label="Feedback"
          value={summary?.feedback.total ?? "—"}
          detail="Across configured products"
          Icon={MessageSquare}
        />
        <StatCard
          label="Products ready"
          value={`${configuredProducts}/${products.length || 0}`}
          detail="Domain and origin allowlist set"
          Icon={ShieldCheck}
        />
      </div>

      <div className="grid gap-5 2xl:grid-cols-[1.7fr_1fr]">
        <div className="min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-950">Product readiness</h2>
              <p className="mt-1 text-sm text-slate-500">Embed setup, review intake, and feedback volume.</p>
            </div>
            <Link to="/settings" className="text-sm font-semibold text-slate-700 hover:text-slate-950">
              Settings
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-600">Product</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-600">Domain</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-600">Origins</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-600">Reviews</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-600">Feedback</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-slate-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summaryQuery.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">
                      Loading products...
                    </td>
                  </tr>
                ) : summaryQuery.isError ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-sm text-red-600">
                      Couldn&apos;t load products. Try refreshing.
                    </td>
                  </tr>
                ) : productRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">
                      No products configured yet.
                    </td>
                  </tr>
                ) : (
                  productRows.map((product) => (
                    <tr key={product.id} className="hover:bg-slate-50">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <span
                            className="h-3 w-3 rounded-full ring-2 ring-white"
                            style={{ backgroundColor: product.brand_color ?? "#475569" }}
                          />
                          <div>
                            <p className="text-sm font-semibold text-slate-950">{product.name}</p>
                            <p className="text-xs text-slate-500">{product.slug}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-600">
                        {product.primary_domain ?? <span className="text-slate-500">Not set</span>}
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-600">{product.originCount}</td>
                      <td className="px-5 py-4 text-sm text-slate-600">{product.review_count}</td>
                      <td className="px-5 py-4 text-sm text-slate-600">{product.feedback_count}</td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-semibold",
                            product.isConfigured
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700",
                          )}
                        >
                          {product.isConfigured ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : (
                            <CircleAlert className="h-3.5 w-3.5" />
                          )}
                          {product.isConfigured ? "Ready" : "Needs setup"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 className="font-semibold text-slate-950">Work queue</h2>
              <p className="mt-1 text-sm text-slate-500">The next moderation and collection tasks.</p>
            </div>
            <div className="divide-y divide-slate-100">
              {pendingTestimonials.length > 0 ? (
                pendingTestimonials.map((testimonial) => (
                  <Link
                    key={testimonial.id}
                    to="/wall?status=pending"
                    className="block px-5 py-4 transition hover:bg-slate-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="line-clamp-2 text-sm font-medium leading-5 text-slate-900">
                        {testimonial.quote}
                      </p>
                      <span className="shrink-0 text-xs text-slate-500">{formatDate(testimonial.created_at)}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {testimonial.customer_name ?? "Unknown customer"}
                    </p>
                  </Link>
                ))
              ) : (
                <div className="px-5 py-8 text-center">
                  <Inbox className="mx-auto h-6 w-6 text-slate-400" />
                  <p className="mt-2 text-sm font-medium text-slate-700">No testimonials waiting</p>
                  <p className="mt-1 text-sm text-slate-500">Approved items and new imports will show up here.</p>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-3">
            <ActionCard
              to="/reviews"
              title="Import reviews"
              detail={`${summary?.reviews.total ?? 0} reviews are currently in the review pool.`}
              Icon={Download}
            />
            <ActionCard
              to="/feedback"
              title="Triage feedback"
              detail="Move bugs, feature requests, and general notes through the board."
              Icon={ClipboardList}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
