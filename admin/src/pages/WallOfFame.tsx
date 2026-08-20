import { useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Star, X, ChevronDown } from "lucide-react";
import { api, getErrorMessage } from "@admin/lib/api";
import { QueryError } from "@admin/components/QueryError";
import { cn } from "@admin/lib/utils";
import { Button } from "@admin/components/Button";
import { useModalDismiss } from "@admin/lib/useModalDismiss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TestimonialSource = "twitter" | "email" | "manual" | "widget" | "import";

interface Testimonial {
  id: string;
  customer_id: string;
  product_id: string;
  quote: string;
  source: TestimonialSource;
  source_url: string | null;
  rating: number | null;
  approved: number;
  featured: number;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
}

interface TestimonialListResponse {
  testimonials: Testimonial[];
  total: number;
}

interface Product {
  id: string;
  slug: string;
  name: string;
}

interface Customer {
  id: string;
  name: string;
  email: string | null;
}

interface CustomerListResponse {
  customers?: Customer[];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<TestimonialSource, string> = {
  twitter: "Twitter",
  email: "Email",
  manual: "Manual",
  widget: "Widget",
  import: "Import",
};

const SOURCE_COLORS: Record<TestimonialSource, string> = {
  twitter: "bg-sky-100 text-sky-700",
  email: "bg-violet-100 text-violet-700",
  manual: "bg-slate-100 text-slate-700",
  widget: "bg-emerald-100 text-emerald-700",
  import: "bg-amber-100 text-amber-700",
};

function RatingStars({ rating }: { rating: number | null }) {
  if (!rating) return null;
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn(
            "h-3.5 w-3.5",
            n <= rating ? "fill-amber-400 text-amber-400" : "fill-slate-200 text-slate-200",
          )}
        />
      ))}
    </span>
  );
}

function SourceBadge({ source }: { source: TestimonialSource }) {
  return (
    <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", SOURCE_COLORS[source])}>
      {SOURCE_LABELS[source]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add Testimonial modal
// ---------------------------------------------------------------------------

interface AddModalProps {
  products: Product[];
  customers: Customer[];
  onClose: () => void;
  onCreated: () => void;
}

function AddModal({ products, customers, onClose, onCreated }: AddModalProps) {
  const [customerId, setCustomerId] = useState("");
  const [productId, setProductId] = useState("");
  const [quote, setQuote] = useState("");
  const [source, setSource] = useState<TestimonialSource>("manual");
  const [sourceUrl, setSourceUrl] = useState("");
  const [rating, setRating] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const quoteRef = useRef<HTMLTextAreaElement>(null);
  const productSelectRef = useRef<HTMLSelectElement>(null);
  const customerSelectRef = useRef<HTMLSelectElement>(null);
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);

  const mutation = useMutation({
    mutationFn: (body: object) => api.post<Testimonial>("testimonials", body),
    onSuccess: () => {
      onCreated();
      onClose();
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err));
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInvalidField(null);
    if (!quote.trim()) { setError("Quote is required"); setInvalidField("quote"); quoteRef.current?.focus(); return; }
    if (!productId) { setError("Select a product"); setInvalidField("product"); productSelectRef.current?.focus(); return; }
    if (!customerId) { setError("Select a customer"); setInvalidField("customer"); customerSelectRef.current?.focus(); return; }
    mutation.mutate({
      customer_id: customerId,
      product_id: productId,
      quote: quote.trim(),
      source,
      source_url: sourceUrl.trim() || undefined,
      rating: rating ? parseInt(rating, 10) : undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-testimonial-title"
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 focus:outline-none"
      >
        <div className="flex items-center justify-between mb-5">
          <h2 id="add-testimonial-title" className="text-lg font-semibold text-slate-900">Add Testimonial</h2>
          <Button variant="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Customer</label>
            <div className="relative">
              <select
                ref={customerSelectRef}
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                aria-invalid={invalidField === "customer" ? true : undefined}
                aria-describedby={invalidField === "customer" ? "wall-add-error" : undefined}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <option value="">Select a customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.email ? ` (${c.email})` : ""}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Product</label>
            <div className="relative">
              <select
                ref={productSelectRef}
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                aria-invalid={invalidField === "product" ? true : undefined}
                aria-describedby={invalidField === "product" ? "wall-add-error" : undefined}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-slate-400"
              >
                <option value="">Select a product…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Quote</label>
            <textarea
              ref={quoteRef}
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
              rows={4}
              placeholder="Customer's testimonial text…"
              aria-invalid={invalidField === "quote" ? true : undefined}
              aria-describedby={invalidField === "quote" ? "wall-add-error" : undefined}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Source</label>
              <div className="relative">
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as TestimonialSource)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  {(Object.keys(SOURCE_LABELS) as TestimonialSource[]).map((s) => (
                    <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Rating</label>
              <div className="relative">
                <select
                  value={rating}
                  onChange={(e) => setRating(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-slate-400"
                >
                  <option value="">None</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{n} star{n !== 1 ? "s" : ""}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Source URL</label>
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://…"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          {error && <p id="wall-add-error" role="alert" className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              isLoading={mutation.isPending}
              className="bg-brand-700 hover:bg-brand-800"
            >
              {mutation.isPending ? "Adding…" : "Add Testimonial"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit drawer
// ---------------------------------------------------------------------------

interface EditDrawerProps {
  testimonial: Testimonial;
  onClose: () => void;
  onSaved: () => void;
}

function EditDrawer({ testimonial, onClose, onSaved }: EditDrawerProps) {
  const [quote, setQuote] = useState(testimonial.quote);
  const [source, setSource] = useState<TestimonialSource>(testimonial.source);
  const [rating, setRating] = useState<string>(testimonial.rating?.toString() ?? "");
  const [sourceUrl, setSourceUrl] = useState(testimonial.source_url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const editQuoteRef = useRef<HTMLTextAreaElement>(null);
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);

  const mutation = useMutation({
    mutationFn: (body: object) => api.patch<Testimonial>(`testimonials/${testimonial.id}`, body),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err));
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInvalidField(null);
    if (!quote.trim()) { setError("Quote cannot be empty"); setInvalidField("quote"); editQuoteRef.current?.focus(); return; }
    mutation.mutate({
      quote: quote.trim(),
      source,
      rating: rating ? parseInt(rating, 10) : null,
      source_url: sourceUrl.trim() || null,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-testimonial-title"
        className="bg-white w-full max-w-md shadow-xl flex flex-col focus:outline-none"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 id="edit-testimonial-title" className="text-base font-semibold text-slate-900">Edit Testimonial</h2>
          <Button variant="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          <div className="mb-4">
            <p className="text-xs text-slate-500 mb-1">Customer</p>
            <p className="text-sm font-medium text-slate-900">
              {testimonial.customer_name ?? "Unknown"}
            </p>
            {testimonial.customer_email && (
              <p className="text-xs text-slate-500">{testimonial.customer_email}</p>
            )}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Quote</label>
              <textarea
                ref={editQuoteRef}
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                rows={5}
                aria-invalid={invalidField === "quote" ? true : undefined}
                aria-describedby={invalidField === "quote" ? "wall-edit-error" : undefined}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Source</label>
                <div className="relative">
                  <select
                    aria-label="Edit testimonial source"
                    value={source}
                    onChange={(e) => setSource(e.target.value as TestimonialSource)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  >
                    {(Object.keys(SOURCE_LABELS) as TestimonialSource[]).map((s) => (
                      <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Rating</label>
                <div className="relative">
                  <select
                    value={rating}
                    onChange={(e) => setRating(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-slate-400"
                  >
                    <option value="">None</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>{n} star{n !== 1 ? "s" : ""}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Source URL</label>
              <input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://…"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>

            {error && <p id="wall-edit-error" role="alert" className="text-sm text-red-600">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                isLoading={mutation.isPending}
                className="bg-brand-700 hover:bg-brand-800"
              >
                {mutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Testimonial card — pending
// ---------------------------------------------------------------------------

interface PendingCardProps {
  testimonial: Testimonial;
  productName: string;
  onApprove: () => void;
  onDelete: () => void;
  onClick: () => void;
}

function PendingCard({ testimonial, productName, onApprove, onDelete, onClick }: PendingCardProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`View testimonial from ${testimonial.customer_name ?? "unknown customer"}`}
      className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 cursor-pointer hover:border-slate-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <p className="text-sm text-slate-800 line-clamp-3">"{testimonial.quote}"</p>

      <div className="flex items-center gap-2 flex-wrap">
        <SourceBadge source={testimonial.source} />
        <span className="text-xs font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
          {productName}
        </span>
        <RatingStars rating={testimonial.rating} />
      </div>

      <div className="text-xs text-slate-500">
        {testimonial.customer_name ?? "Unknown customer"}
        {testimonial.customer_email && (
          <span className="ml-1 text-slate-500">· {testimonial.customer_email}</span>
        )}
      </div>

      <div className="flex gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
        <Button
          size="sm"
          className="bg-emerald-600 hover:bg-emerald-700"
          onClick={onApprove}
        >
          Approve
        </Button>
        {confirming ? (
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              onClick={onDelete}
            >
              Confirm delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="danger"
            size="sm"
            className="bg-red-500 hover:bg-red-600"
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Testimonial card — approved
// ---------------------------------------------------------------------------

interface ApprovedCardProps {
  testimonial: Testimonial;
  productName: string;
  onToggleFeatured: () => void;
  onDelete: () => void;
  onClick: () => void;
}

function ApprovedCard({ testimonial, productName, onToggleFeatured, onDelete, onClick }: ApprovedCardProps) {
  const isFeatured = testimonial.featured === 1;
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`View testimonial from ${testimonial.customer_name ?? "unknown customer"}`}
      className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 cursor-pointer hover:border-slate-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <p className="text-sm text-slate-800 line-clamp-3">"{testimonial.quote}"</p>

      <div className="flex items-center gap-2 flex-wrap">
        <SourceBadge source={testimonial.source} />
        <span className="text-xs font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
          {productName}
        </span>
        <RatingStars rating={testimonial.rating} />
      </div>

      <div className="text-xs text-slate-500">
        {testimonial.customer_name ?? "Unknown customer"}
        {testimonial.customer_email && (
          <span className="ml-1 text-slate-500">· {testimonial.customer_email}</span>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
        <Button
          variant="icon"
          size="sm"
          title={isFeatured ? "Unfeature" : "Feature"}
          aria-label={isFeatured ? "Unfeature testimonial" : "Feature testimonial"}
          aria-pressed={isFeatured}
          className={cn(
            isFeatured
              ? "text-amber-500 hover:text-amber-600 bg-amber-50 hover:bg-amber-100"
              : "text-slate-400 hover:text-amber-500 hover:bg-amber-50",
          )}
          onClick={onToggleFeatured}
        >
          <Star aria-hidden="true" className={cn("h-4 w-4", isFeatured && "fill-current")} />
        </Button>
        {confirming ? (
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              onClick={onDelete}
            >
              Confirm delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="danger"
            size="sm"
            className="bg-red-500 hover:bg-red-600"
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type TabId = "pending" | "approved";

export function WallOfFame() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive the active tab from the URL so deep-links (?status=…) and tab clicks
  // stay in sync in both directions. Any value other than "approved" is treated
  // as "pending".
  const tab: TabId = searchParams.get("status") === "approved" ? "approved" : "pending";
  const setTab = (next: TabId) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("status", next);
        return params;
      },
      { replace: true },
    );
  };

  const [filterProductId, setFilterProductId] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [editTarget, setEditTarget] = useState<Testimonial | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: ["products"],
    queryFn: () => api.get<Product[]>("settings/products"),
  });

  const customersQuery = useQuery({
    queryKey: ["customers"],
    queryFn: () => api.get<CustomerListResponse>("customers?limit=500"),
  });

  const pendingParams = new URLSearchParams({ approved: "0", limit: "200" });
  if (filterProductId) pendingParams.set("product_id", filterProductId);

  const approvedParams = new URLSearchParams({ approved: "1", limit: "200" });
  if (filterProductId) approvedParams.set("product_id", filterProductId);

  const pendingQuery = useQuery({
    queryKey: ["testimonials", "pending", filterProductId],
    queryFn: () => api.get<TestimonialListResponse>(`testimonials?${pendingParams}`),
  });

  const approvedQuery = useQuery({
    queryKey: ["testimonials", "approved", filterProductId],
    queryFn: () => api.get<TestimonialListResponse>(`testimonials?${approvedParams}`),
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ["testimonials"] });
  }

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.post<Testimonial>(`testimonials/${id}/approve`, {}),
    onSuccess: () => { setActionError(null); invalidate(); },
    onError: (err: unknown) => setActionError(getErrorMessage(err)),
  });

  const featureMutation = useMutation({
    mutationFn: (id: string) => api.post<Testimonial>(`testimonials/${id}/feature`, {}),
    onSuccess: () => { setActionError(null); invalidate(); },
    onError: (err: unknown) => setActionError(getErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`testimonials/${id}`),
    onSuccess: () => { setActionError(null); invalidate(); },
    onError: (err: unknown) => setActionError(getErrorMessage(err)),
  });

  const products = productsQuery.data ?? [];
  const customers = customersQuery.data?.customers ?? [];

  function productName(id: string) {
    return products.find((p) => p.id === id)?.name ?? id;
  }

  const pending = pendingQuery.data?.testimonials ?? [];
  const approved = approvedQuery.data?.testimonials ?? [];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Wall of Fame</h1>
        <Button
          className="bg-brand-700 hover:bg-brand-800"
          onClick={() => setShowAddModal(true)}
        >
          Add Testimonial
        </Button>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <div className="inline-flex rounded-full bg-slate-100 p-1 gap-1">
          {(["pending", "approved"] as TabId[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "px-4 py-2 text-sm font-medium rounded-full transition-colors",
                tab === t
                  ? "bg-brand-700 text-white shadow-sm"
                  : "bg-transparent text-slate-600 hover:bg-slate-200",
              )}
            >
              {t === "pending" ? "Pending Approval" : "Approved"}
              {t === "pending" && pending.length > 0 && (
                <span className="ml-2 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold h-4 min-w-4 px-1">
                  {pending.length}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <select
            aria-label="Filter testimonials by product"
            value={filterProductId}
            onChange={(e) => setFilterProductId(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white"
          >
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4 text-slate-400" />
        </div>
      </div>

      {actionError && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span className="flex-1">{actionError}</span>
          <Button
            variant="icon"
            size="sm"
            aria-label="Dismiss error"
            className="shrink-0 text-red-400 hover:bg-red-100 hover:text-red-600"
            onClick={() => setActionError(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {tab === "pending" && (
        <>
          {pendingQuery.isError ? (
            <QueryError error={pendingQuery.error} onRetry={() => void pendingQuery.refetch()} />
          ) : pendingQuery.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : pending.length === 0 ? (
            <div className="text-center py-16 text-slate-600">
              <Star className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No pending testimonials</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {pending.map((t) => (
                <PendingCard
                  key={t.id}
                  testimonial={t}
                  productName={productName(t.product_id)}
                  onApprove={() => approveMutation.mutate(t.id)}
                  onDelete={() => deleteMutation.mutate(t.id)}
                  onClick={() => setEditTarget(t)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {tab === "approved" && (
        <>
          {approvedQuery.isError ? (
            <QueryError error={approvedQuery.error} onRetry={() => void approvedQuery.refetch()} />
          ) : approvedQuery.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : approved.length === 0 ? (
            <div className="text-center py-16 text-slate-600">
              <Star className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">
                No approved testimonials yet — approve some or add one.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {approved.map((t) => (
                <ApprovedCard
                  key={t.id}
                  testimonial={t}
                  productName={productName(t.product_id)}
                  onToggleFeatured={() => featureMutation.mutate(t.id)}
                  onDelete={() => deleteMutation.mutate(t.id)}
                  onClick={() => setEditTarget(t)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {showAddModal && (
        <AddModal
          products={products}
          customers={customers}
          onClose={() => setShowAddModal(false)}
          onCreated={invalidate}
        />
      )}

      {editTarget && (
        <EditDrawer
          testimonial={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}
