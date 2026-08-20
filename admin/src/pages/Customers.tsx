import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { api, getErrorMessage } from "@admin/lib/api";
import { QueryError } from "@admin/components/QueryError";
import { cn } from "@admin/lib/utils";
import { Button } from "@admin/components/Button";
import { useModalDismiss } from "@admin/lib/useModalDismiss";

// ---------------------------------------------------------------------------
// Local types (mirrors src/db/queries.ts interfaces)
// ---------------------------------------------------------------------------

type Lifecycle = "lead" | "active" | "churned" | "champion";

interface Customer {
  id: string;
  name: string;
  email: string | null;
  photo_r2_key: string | null;
  company: string | null;
  role: string | null;
  twitter: string | null;
  linkedin: string | null;
  website: string | null;
  lifecycle: Lifecycle;
  notes: string | null;
  created_at: string;
  updated_at: string;
  products?: Product[];
}

interface Product {
  id: string;
  slug: string;
  name: string;
  brand_color: string | null;
  primary_domain: string | null;
  widget_public_key: string;
  origin_allowlist_json: string;
  firewall_group: string | null;
  created_at: string;
}

interface Testimonial {
  id: string;
  customer_id: string;
  product_id: string;
  quote: string;
  source: string;
  source_url: string | null;
  rating: number | null;
  approved: number;
  featured: number;
  created_at: string;
}

interface FeedbackItem {
  id: string;
  customer_id: string | null;
  product_id: string;
  type: string;
  title: string;
  body: string | null;
  status: string;
  upvotes: number;
  public_visible: number;
  created_at: string;
  updated_at: string;
}

interface Review {
  id: string;
  customer_id: string | null;
  product_id: string;
  source: string;
  external_id: string;
  rating: number | null;
  body: string;
  author_name: string | null;
  source_url: string | null;
  imported_at: string;
}

interface CustomerListResponse {
  customers: Customer[];
  total: number;
}

interface CustomerDetailResponse {
  customer: Customer;
  products: Product[];
  testimonials: Testimonial[];
  feedback: FeedbackItem[];
  reviews: Review[];
}

type TimelineItemKind = "testimonial" | "feedback" | "review";

interface TimelineItem {
  id: string;
  kind: TimelineItemKind;
  title: string;
  body: string;
  meta: string[];
  at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIFECYCLE_OPTIONS: { value: Lifecycle | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "lead", label: "Lead" },
  { value: "active", label: "Active" },
  { value: "churned", label: "Churned" },
  { value: "champion", label: "Champion" },
];

const LIFECYCLE_COLORS: Record<Lifecycle, string> = {
  lead: "bg-blue-100 text-blue-700",
  active: "bg-green-100 text-green-700",
  churned: "bg-red-100 text-red-700",
  champion: "bg-purple-100 text-purple-700",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("")
    .toUpperCase();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatKind(kind: TimelineItemKind): string {
  if (kind === "testimonial") return "Testimonial";
  if (kind === "feedback") return "Feedback";
  return "Review";
}

function buildCustomerTimeline(
  testimonials: Testimonial[],
  feedback: FeedbackItem[],
  reviews: Review[],
): TimelineItem[] {
  return [
    ...testimonials.map((t): TimelineItem => ({
      id: t.id,
      kind: "testimonial",
      title: "Testimonial",
      body: `"${t.quote}"`,
      meta: [
        t.source,
        t.approved === 1 ? "approved" : "pending",
        ...(t.rating != null ? [`rating ${t.rating}`] : []),
      ],
      at: t.created_at,
    })),
    ...feedback.map((f): TimelineItem => ({
      id: f.id,
      kind: "feedback",
      title: f.title,
      body: f.body ?? "",
      meta: [f.type.replace("_", " "), f.status.replace("_", " "), `${f.upvotes} upvotes`],
      at: f.updated_at || f.created_at,
    })),
    ...reviews.map((r): TimelineItem => ({
      id: r.id,
      kind: "review",
      title: r.author_name ? `Review from ${r.author_name}` : "Review",
      body: r.body,
      meta: [
        r.source.replace("_", " "),
        ...(r.rating != null ? [`rating ${r.rating}`] : []),
      ],
      at: r.imported_at,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function Avatar({
  name,
  size = "md",
  photoKey,
}: {
  name: string;
  size?: "sm" | "md";
  photoKey?: string | null;
}) {
  const sz = size === "sm" ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm";
  const [imgFailed, setImgFailed] = useState(false);

  // Reset failed state if photoKey changes (e.g. switching customers or uploading a new photo).
  useEffect(() => {
    setImgFailed(false);
  }, [photoKey]);

  if (photoKey && !imgFailed) {
    return (
      <img
        src={`/media/${photoKey}`}
        alt={name}
        className={cn("rounded-full object-cover shrink-0", sz)}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return (
    <div
      className={cn(
        "rounded-full bg-indigo-100 text-indigo-700 font-semibold flex items-center justify-center shrink-0",
        sz,
      )}
    >
      {initials(name)}
    </div>
  );
}

function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize",
        LIFECYCLE_COLORS[lifecycle],
      )}
    >
      {lifecycle}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Add Customer Sheet
// ---------------------------------------------------------------------------

interface AddCustomerSheetProps {
  open: boolean;
  onClose: () => void;
  products: Product[];
}

function AddCustomerSheet({ open, onClose, products }: AddCustomerSheetProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    role: "",
    twitter: "",
    linkedin: "",
    website: "",
    lifecycle: "lead" as Lifecycle,
    notes: "",
    product_ids: [] as string[],
  });
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);

  const createMutation = useMutation({
    mutationFn: (data: typeof form) =>
      api.post<Customer>("customers", {
        ...data,
        email: data.email || undefined,
        company: data.company || undefined,
        role: data.role || undefined,
        twitter: data.twitter || undefined,
        linkedin: data.linkedin || undefined,
        website: data.website || undefined,
        notes: data.notes || undefined,
        product_ids: data.product_ids.length ? data.product_ids : undefined,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["customers"] });
      setForm({
        name: "",
        email: "",
        company: "",
        role: "",
        twitter: "",
        linkedin: "",
        website: "",
        lifecycle: "lead",
        notes: "",
        product_ids: [],
      });
      setError(null);
      onClose();
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err));
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    },
  });

  const toggle = (id: string) => {
    setForm((f) => ({
      ...f,
      product_ids: f.product_ids.includes(id)
        ? f.product_ids.filter((p) => p !== id)
        : [...f.product_ids, id],
    }));
  };

  const handleCreate = () => {
    if (!form.name.trim()) {
      setError("Name is required.");
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      nameRef.current?.focus();
      return;
    }
    createMutation.mutate(form);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="fixed inset-0 bg-black/40" onClick={onBackdropClick} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative ml-auto h-full w-full max-w-md bg-white shadow-xl flex flex-col focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-add-title"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 id="customer-add-title" className="text-lg font-semibold text-gray-900">Add Customer</h2>
          <Button variant="icon" size="sm" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div
              id="customer-add-error"
              role="alert"
              className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              ref={nameRef}
              aria-invalid={error === "Name is required." ? true : undefined}
              aria-describedby={error === "Name is required." ? "customer-add-error" : undefined}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Jane Smith"
            />
          </div>

          {(
            [
              { field: "email", label: "Email", placeholder: "jane@example.com" },
              { field: "company", label: "Company", placeholder: "Acme Inc." },
              { field: "role", label: "Role", placeholder: "CTO" },
              { field: "twitter", label: "Twitter", placeholder: "janesmith" },
              { field: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/in/..." },
              { field: "website", label: "Website", placeholder: "https://example.com" },
            ] as { field: keyof typeof form; label: string; placeholder: string }[]
          ).map(({ field, label, placeholder }) => (
            <div key={field}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
              <input
                aria-label={label}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={form[field] as string}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                placeholder={placeholder}
              />
            </div>
          ))}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Lifecycle</label>
            <select
              aria-label="Lifecycle"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={form.lifecycle}
              onChange={(e) => setForm((f) => ({ ...f, lifecycle: e.target.value as Lifecycle }))}
            >
              {LIFECYCLE_OPTIONS.filter((o) => o.value !== "all").map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              aria-label="Notes"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Any notes..."
            />
          </div>

          {products.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Products</label>
              <div className="space-y-1">
                {products.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.product_ids.includes(p.id)}
                      onChange={() => toggle(p.id)}
                      className="rounded border-gray-300 text-indigo-600"
                    />
                    <span className="text-sm text-gray-700">{p.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            isLoading={createMutation.isPending}
            onClick={handleCreate}
          >
            {createMutation.isPending ? "Creating…" : "Create Customer"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merge Modal
// ---------------------------------------------------------------------------

interface MergeModalProps {
  targetId: string;
  onClose: () => void;
  onSuccess: () => void;
}

function MergeModal({ targetId, onClose, onSuccess }: MergeModalProps) {
  const [sourceId, setSourceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const mergeSearchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);

  // Debounce the search input
  useEffect(() => {
    if (mergeSearchTimer.current) clearTimeout(mergeSearchTimer.current);
    mergeSearchTimer.current = setTimeout(() => setDebouncedTerm(searchTerm), 300);
    return () => {
      if (mergeSearchTimer.current) clearTimeout(mergeSearchTimer.current);
    };
  }, [searchTerm]);

  const { data: searchData } = useQuery({
    queryKey: ["customers", "merge-search", targetId, debouncedTerm],
    queryFn: () =>
      api.get<{ customers: Customer[]; total: number }>(
        `customers?search=${encodeURIComponent(debouncedTerm)}&limit=50`,
      ),
  });

  const searchResults = searchData?.customers ?? [];
  const searchTotal = searchData?.total ?? 0;
  const others = searchResults.filter((c) => c.id !== targetId);

  const mergeMutation = useMutation({
    mutationFn: () => api.post<Customer>(`customers/${targetId}/merge`, { source_id: sourceId }),
    onSuccess: () => {
      onSuccess();
      onClose();
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err));
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onBackdropClick} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-merge-title"
        className="relative bg-white rounded-lg shadow-xl w-full max-w-sm p-6 focus:outline-none"
      >
        <h2 id="customer-merge-title" className="text-base font-semibold text-gray-900 mb-4">Merge Duplicate</h2>
        <p className="text-sm text-gray-600 mb-3">
          Select the source customer to merge into this record. The source will be deleted after merge.
        </p>

        {error && (
          <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <input
          type="search"
          aria-label="Search customers to merge"
          placeholder="Search customers…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        {searchTotal > searchResults.length && (
          <p className="text-xs text-gray-400 mb-2">
            Refine your search to narrow results.
          </p>
        )}

        <select
          aria-label="Select source customer"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
        >
          <option value="">Select source customer…</option>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} {c.email ? `(${c.email})` : ""}
            </option>
          ))}
        </select>

        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!sourceId}
            isLoading={mergeMutation.isPending}
            onClick={() => mergeMutation.mutate()}
          >
            {mergeMutation.isPending ? "Merging…" : "Merge & Delete Source"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer Detail Panel
// ---------------------------------------------------------------------------

interface DetailPanelProps {
  customerId: string;
  allProducts: Product[];
  onClose: () => void;
}

function DetailPanel({ customerId, allProducts, onClose }: DetailPanelProps) {
  const qc = useQueryClient();
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);
  const [editing, setEditing] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [patch, setPatch] = useState<Partial<Customer>>({});
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["customer", customerId],
    queryFn: () => api.get<CustomerDetailResponse>(`customers/${customerId}`),
  });

  const updateMutation = useMutation({
    mutationFn: (p: Partial<Customer>) => api.patch<Customer>(`customers/${customerId}`, p),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["customer", customerId] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
      setUpdateError(null);
      setEditing(false);
      setPatch({});
    },
    onError: (err: unknown) => {
      setUpdateError(getErrorMessage(err));
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: (productId: string) => api.delete(`customers/${customerId}/products/${productId}`),
    onSuccess: () => {
      setUnlinkError(null);
      void qc.invalidateQueries({ queryKey: ["customer", customerId] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (err: unknown) => {
      setUnlinkError(getErrorMessage(err));
    },
  });

  const linkMutation = useMutation({
    mutationFn: (productId: string) =>
      api.post<{ linked: boolean }>(`customers/${customerId}/link-product`, { product_id: productId }),
    onSuccess: () => {
      setLinkError(null);
      void qc.invalidateQueries({ queryKey: ["customer", customerId] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (err: unknown) => {
      setLinkError(getErrorMessage(err));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`customers/${customerId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["customers"] });
      setDeleteError(null);
      onClose();
    },
    onError: (err: unknown) => {
      setDeleteError(getErrorMessage(err));
    },
  });

  const photoMutation = useMutation({
    mutationFn: async (file: File) => {
      const { key } = await api.upload<{ key: string }>("media", file);
      return api.patch<Customer>(`customers/${customerId}`, { photo_r2_key: key });
    },
    onSuccess: () => {
      setPhotoError(null);
      void qc.invalidateQueries({ queryKey: ["customer", customerId] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (err: unknown) => {
      setPhotoError(getErrorMessage(err));
    },
  });

  const removePhotoMutation = useMutation({
    mutationFn: () => api.patch<Customer>(`customers/${customerId}`, { photo_r2_key: null }),
    onSuccess: () => {
      setPhotoError(null);
      void qc.invalidateQueries({ queryKey: ["customer", customerId] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });

  if (isLoading || !data) {
    return (
      <div
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-40 w-full max-w-xl bg-white shadow-xl flex items-center justify-center"
        role="dialog"
        aria-modal="true"
        aria-label="Customer detail"
      >
        <div className="text-gray-400 text-sm">Loading…</div>
      </div>
    );
  }

  const { customer, products, testimonials, feedback, reviews } = data;
  const linkedProductIds = new Set(products.map((p) => p.id));
  const unlinkableProducts = allProducts.filter((p) => !linkedProductIds.has(p.id));
  const timeline = buildCustomerTimeline(testimonials, feedback, reviews);

  const field = (
    label: string,
    key: keyof Customer,
    placeholder?: string,
  ) => {
    const val = editing ? (patch[key] ?? customer[key]) : customer[key];
    const fieldId = `customer-field-${String(key)}`;
    return (
      <div>
        <label
          htmlFor={fieldId}
          className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-0.5"
        >
          {label}
        </label>
        {editing ? (
          <input
            id={fieldId}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={(val as string) ?? ""}
            placeholder={placeholder}
            onChange={(e) => setPatch((p) => ({ ...p, [key]: e.target.value || null }))}
          />
        ) : (
          <p className="text-sm text-gray-800">{(val as string) ?? "—"}</p>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onBackdropClick} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-40 w-full max-w-xl bg-white shadow-xl flex flex-col overflow-hidden focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={`Customer detail: ${customer.name}`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Avatar name={customer.name} photoKey={customer.photo_r2_key} />
            <div>
              <p id="customer-detail-title" className="font-semibold text-gray-900 text-sm leading-tight">{customer.name}</p>
              <p className="text-xs text-gray-500">{customer.email ?? "no email"}</p>
              {editing && (
                <div className="mt-1 flex items-center gap-2">
                  <label className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 cursor-pointer">
                    {photoMutation.isPending ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Uploading…
                      </>
                    ) : customer.photo_r2_key ? "Replace photo" : "Upload photo"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      disabled={photoMutation.isPending}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (!f) return;
                        if (f.size > 5 * 1024 * 1024) {
                          setPhotoError("Photo must be 5MB or smaller");
                          return;
                        }
                        photoMutation.mutate(f);
                      }}
                    />
                  </label>
                  {customer.photo_r2_key && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removePhotoMutation.mutate()}
                      disabled={removePhotoMutation.isPending}
                      className="text-gray-500 hover:text-red-600"
                    >
                      Remove
                    </Button>
                  )}
                </div>
              )}
              {photoError && (
                <p className="mt-1 text-xs text-red-600">{photoError}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowMerge(true)}>
              Merge into…
            </Button>
            {editing ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setEditing(false); setPatch({}); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  isLoading={updateMutation.isPending}
                  onClick={() => { setUpdateError(null); updateMutation.mutate(patch); }}
                >
                  Save
                </Button>
                {updateError && (
                  <p className="text-xs text-red-600 mt-1">{updateError}</p>
                )}
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:bg-red-50"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
              </>
            )}
            <Button
              variant="icon"
              size="sm"
              aria-label="Close"
              className="ml-1"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {deleteError && (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {deleteError}
            </div>
          )}
          {confirmDelete && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3">
              <p className="text-sm font-medium text-red-800">Delete this customer?</p>
              <p className="mt-1 text-sm text-red-700">
                Linked feedback and reviews will be detached. Customers with testimonials must have those testimonials reassigned or deleted first.
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  isLoading={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                >
                  {deleteMutation.isPending ? "Deleting..." : "Delete Customer"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setConfirmDelete(false); setDeleteError(null); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {field("Name", "name", "Jane Smith")}
            {field("Email", "email", "jane@example.com")}
            {field("Company", "company", "Acme Inc.")}
            {field("Role", "role", "CTO")}
            {field("Twitter", "twitter", "handle")}
            {field("LinkedIn", "linkedin", "URL")}
            {field("Website", "website", "URL")}
            <div>
              <span className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-0.5">
                Lifecycle
              </span>
              {editing ? (
                <select
                  aria-label="Lifecycle"
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  value={(patch.lifecycle ?? customer.lifecycle) as string}
                  onChange={(e) => setPatch((p) => ({ ...p, lifecycle: e.target.value as Lifecycle }))}
                >
                  {LIFECYCLE_OPTIONS.filter((o) => o.value !== "all").map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <LifecycleBadge lifecycle={customer.lifecycle} />
              )}
            </div>
          </div>

          <div>
            <span className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-0.5">
              Notes
            </span>
            {editing ? (
              <textarea
                aria-label="Notes"
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                rows={3}
                value={(patch.notes ?? customer.notes) ?? ""}
                onChange={(e) => setPatch((p) => ({ ...p, notes: e.target.value || null }))}
              />
            ) : (
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{customer.notes ?? "—"}</p>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Linked Products
            </p>
            {linkError && (
              <p className="text-xs text-red-600 mb-2">{linkError}</p>
            )}
            {unlinkError && (
              <p className="text-xs text-red-600 mb-2">{unlinkError}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {products.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 text-xs px-2 py-1 rounded"
                >
                  {p.name}
                  <Button
                    variant="icon"
                    size="sm"
                    aria-label={`Unlink ${p.name}`}
                    onClick={() => unlinkMutation.mutate(p.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </span>
              ))}
              {unlinkableProducts.length > 0 && (
                <select
                  aria-label="Add product"
                  className="text-xs border border-dashed border-gray-300 rounded px-2 py-1 text-gray-500 focus:outline-none"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      linkMutation.mutate(e.target.value);
                      e.target.value = "";
                    }
                  }}
                >
                  <option value="">+ Add product</option>
                  {unlinkableProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div>
            <div className="mb-5">
              <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-2">
                <h3 className="text-sm font-semibold text-gray-900">Activity Timeline</h3>
                <span className="text-xs text-gray-400">
                  {timeline.length} item{timeline.length === 1 ? "" : "s"}
                </span>
              </div>

              {timeline.length === 0 ? (
                <p className="text-sm text-gray-400">No customer activity yet.</p>
              ) : (
                <div className="space-y-3">
                  {timeline.map((item) => (
                    <div key={`${item.kind}-${item.id}`} className="rounded-md border border-gray-200 p-3">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">
                          {formatKind(item.kind)}
                        </span>
                        <span className="shrink-0 text-xs text-gray-400">{formatDate(item.at)}</span>
                      </div>
                      <p className="text-sm font-medium text-gray-900">{item.title}</p>
                      {item.body && <p className="mt-0.5 text-sm text-gray-700">{item.body}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                        {item.meta.map((meta) => (
                          <span key={meta} className="capitalize">
                            {meta}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showMerge && (
        <MergeModal
          targetId={customerId}
          onClose={() => setShowMerge(false)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: ["customers"] });
            onClose();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Skeleton rows
// ---------------------------------------------------------------------------

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: 6 }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-4 bg-gray-100 rounded animate-pulse" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Customers page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

export function Customers() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<Lifecycle | "all">("all");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleSearchChange = useCallback((val: string) => {
    setSearch(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setDebouncedSearch(val), 300);
  }, []);

  // Clear any pending debounce timer on unmount (StrictMode-safe).
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  // Reset to page 0 when filters change so we never land on an empty page.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, lifecycle]);

  const qp = new URLSearchParams();
  if (debouncedSearch) qp.set("search", debouncedSearch);
  if (lifecycle !== "all") qp.set("lifecycle", lifecycle);
  qp.set("limit", String(PAGE_SIZE));
  qp.set("offset", String(page * PAGE_SIZE));

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["customers", debouncedSearch, lifecycle, page],
    queryFn: () => api.get<CustomerListResponse>(`customers?${qp.toString()}`),
    placeholderData: keepPreviousData,
  });

  const { data: productsData } = useQuery({
    queryKey: ["products"],
    queryFn: () => api.get<Product[]>("settings/products"),
  });

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;
  const allProducts = productsData ?? [];

  const showPagination = total > PAGE_SIZE;
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Customers</h1>
        <Button onClick={() => setShowAdd(true)}>
          Add Customer
        </Button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <input
          type="search"
          aria-label="Search customers"
          placeholder="Search by name, email or company…"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
        <select
          aria-label="Filter by lifecycle stage"
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          value={lifecycle}
          onChange={(e) => setLifecycle(e.target.value as Lifecycle | "all")}
        >
          {LIFECYCLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {data && (
          <span className="text-sm text-gray-400 ml-auto">
            {total} customer{total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="flex-1 bg-white rounded-lg border border-gray-200 overflow-hidden">
        {isError ? (
          <QueryError error={error} onRetry={() => void refetch()} className="border-0 bg-transparent" />
        ) : !isLoading && customers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-20 text-center">
            <p className="text-gray-500 text-sm mb-3">No customers yet.</p>
            <Button onClick={() => setShowAdd(true)}>
              Add your first customer
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Customer
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Company
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Lifecycle
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Products
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {isLoading ? (
                  <SkeletonRows />
                ) : (
                  customers.map((customer) => (
                    <CustomerRow
                      key={customer.id}
                      customer={customer}
                      products={customer.products ?? []}
                      onClick={() => setSelectedId(customer.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showPagination && (
        <div className="flex items-center justify-between mt-3 px-1">
          <span className="text-sm text-gray-500">
            Showing {rangeStart}–{rangeEnd} of {total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Previous page"
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {showAdd && (
        <AddCustomerSheet
          open={showAdd}
          onClose={() => setShowAdd(false)}
          products={allProducts}
        />
      )}

      {selectedId && (
        <DetailPanel
          customerId={selectedId}
          allProducts={allProducts}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row — extracted to avoid closure issues with hooks
// ---------------------------------------------------------------------------

interface CustomerRowProps {
  customer: Customer;
  products: Product[];
  onClick: () => void;
}

function CustomerRow({ customer, products, onClick }: CustomerRowProps) {
  return (
    <tr
      className="hover:bg-gray-50 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
      onClick={onClick}
      tabIndex={0}
      role="button"
      aria-label={`View ${customer.name}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar name={customer.name} size="sm" photoKey={customer.photo_r2_key} />
          <div>
            <p className="text-sm font-medium text-gray-900">{customer.name}</p>
            {customer.email && (
              <p className="text-xs text-gray-400">{customer.email}</p>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">{customer.company ?? "—"}</td>
      <td className="px-4 py-3">
        <LifecycleBadge lifecycle={customer.lifecycle} />
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {products.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded"
            >
              {p.name}
            </span>
          ))}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-400">{formatDate(customer.created_at)}</td>
    </tr>
  );
}
