import { useState, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, ThumbsUp, Plus, Loader2, Trash2 } from "lucide-react";
import { api, getErrorMessage } from "@admin/lib/api";
import { QueryError } from "@admin/components/QueryError";
import { cn } from "@admin/lib/utils";
import { Button } from "@admin/components/Button";
import { useModalDismiss } from "@admin/lib/useModalDismiss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeedbackType = "feature_request" | "bug" | "general";
type FeedbackStatus = "new" | "triaged" | "planned" | "in_progress" | "shipped" | "declined";

interface FeedbackItem {
  id: string;
  customer_id: string | null;
  product_id: string;
  type: FeedbackType;
  title: string;
  body: string | null;
  status: FeedbackStatus;
  upvotes: number;
  public_visible: number;
  created_at: string;
  updated_at: string;
}

interface Customer {
  id: string;
  name: string;
  email: string | null;
}

interface Product {
  id: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLUMNS: { status: FeedbackStatus; label: string }[] = [
  { status: "new", label: "New" },
  { status: "triaged", label: "Triaged" },
  { status: "planned", label: "Planned" },
  { status: "in_progress", label: "In Progress" },
  { status: "shipped", label: "Shipped" },
  { status: "declined", label: "Declined" },
];

const TYPE_LABELS: Record<FeedbackType, string> = {
  feature_request: "Feature Request",
  bug: "Bug",
  general: "General",
};

const TYPE_BADGE: Record<FeedbackType, string> = {
  feature_request: "bg-slate-100 text-slate-700",
  bug: "bg-red-100 text-red-700",
  general: "bg-slate-100 text-slate-600",
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function useFeedbackItems(productId: string, typeFilter: string) {
  return useQuery<{ items: FeedbackItem[]; total: number }>({
    queryKey: ["feedback", productId, typeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ product_id: productId, limit: "500" });
      if (typeFilter !== "all") params.set("type", typeFilter);
      return api.get<{ items: FeedbackItem[]; total: number }>(`feedback?${params}`);
    },
    enabled: !!productId,
  });
}

function useProducts() {
  return useQuery<Product[]>({
    queryKey: ["products"],
    queryFn: () => api.get<Product[]>("settings/products"),
  });
}

function useCustomers() {
  return useQuery<{ customers: Customer[]; total: number }>({
    queryKey: ["customers"],
    queryFn: () => api.get<{ customers: Customer[]; total: number }>("customers?limit=500"),
  });
}

// ---------------------------------------------------------------------------
// Card component (draggable)
// ---------------------------------------------------------------------------

interface CardProps {
  item: FeedbackItem;
  customerName?: string;
  onClick: () => void;
  overlay?: boolean;
}

function FeedbackCard({ item, customerName, onClick, overlay }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    data: { status: item.status },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  if (overlay) {
    return (
      <div
        className="bg-white rounded-lg border border-slate-200 shadow-lg p-3 cursor-grabbing select-none w-64"
        onClick={onClick}
      >
        <CardContent item={item} customerName={customerName} />
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onClick();
          return;
        }
        // Delegate Space (pick up / drop) and friends to the keyboard drag sensor.
        listeners?.onKeyDown?.(e);
      }}
      className={cn(
        "bg-white rounded-lg border border-slate-200 p-3 cursor-grab select-none transition-shadow",
        "hover:shadow-md hover:border-slate-300 active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
        isDragging && "opacity-40 shadow-none",
      )}
    >
      <CardContent item={item} customerName={customerName} />
    </div>
  );
}

function CardContent({ item, customerName }: { item: FeedbackItem; customerName?: string }) {
  return (
    <>
      <p className="text-sm font-semibold text-slate-900 line-clamp-2">{item.title}</p>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className={cn("text-xs px-1.5 py-0.5 rounded font-medium", TYPE_BADGE[item.type])}>
          {TYPE_LABELS[item.type]}
        </span>
        {customerName && (
          <span className="text-xs text-slate-500 truncate max-w-[100px]">{customerName}</span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span className="flex items-center gap-1">
          <ThumbsUp className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">upvotes: </span>
          {item.upvotes}
        </span>
        <span>{new Date(item.created_at).toLocaleDateString()}</span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Droppable column
// ---------------------------------------------------------------------------

interface ColumnProps {
  status: FeedbackStatus;
  label: string;
  items: FeedbackItem[];
  customerMap: Map<string, string>;
  onCardClick: (item: FeedbackItem) => void;
}

function KanbanColumn({ status, label, items, customerMap, onCardClick }: ColumnProps) {
  const { setNodeRef, isOver } = useSortable({
    id: `col-${status}`,
    data: { isColumn: true, status },
  });

  return (
    <div
      ref={setNodeRef}
      className="flex flex-col w-64 shrink-0"
    >
      <div className="flex items-center gap-2 mb-3 px-1">
        <h3 className="text-sm font-semibold text-slate-700">{label}</h3>
        <span className="bg-slate-100 text-slate-600 text-xs font-medium px-2 py-0.5 rounded-full">
          {items.length}
        </span>
      </div>

      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div
          className={cn(
            "flex flex-col gap-2 min-h-[120px] rounded-lg p-2 transition-colors",
            isOver ? "bg-slate-100 border-2 border-slate-400 border-dashed" : "bg-slate-50",
            items.length === 0 && !isOver &&
              "border-2 border-dashed border-slate-200",
          )}
        >
          {items.length === 0 && !isOver && (
            <div className="flex items-center justify-center h-20 text-xs text-slate-600">
              Drop here
            </div>
          )}
          {items.map((item) => (
            <FeedbackCard
              key={item.id}
              item={item}
              customerName={item.customer_id ? customerMap.get(item.customer_id) : undefined}
              onClick={() => onCardClick(item)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

interface DetailDrawerProps {
  item: FeedbackItem;
  customerMap: Map<string, string>;
  onClose: () => void;
}

function DetailDrawer({ item, customerMap, onClose }: DetailDrawerProps) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body ?? "");
  const [type, setType] = useState<FeedbackType>(item.type);
  const [status, setStatus] = useState<FeedbackStatus>(item.status);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [upvoting, setUpvoting] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  // Inline confirm block — avoids a jarring native confirm() dialog.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["feedback"] });
  }, [queryClient]);

  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);

  async function save() {
    setSaving(true);
    setDrawerError(null);
    try {
      await api.patch(`feedback/${item.id}`, { title, body: body || null, type, status });
      invalidate();
      onClose();
    } catch (err) {
      setDrawerError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function upvote() {
    setUpvoting(true);
    setDrawerError(null);
    try {
      await api.patch(`feedback/${item.id}`, { increment_upvotes: true });
      invalidate();
    } catch (err) {
      setDrawerError(getErrorMessage(err));
    } finally {
      setUpvoting(false);
    }
  }

  async function executeDelete() {
    setDeleting(true);
    setDrawerError(null);
    try {
      await api.delete(`feedback/${item.id}`);
      invalidate();
      onClose();
    } catch (err) {
      // Keep the inline confirm open so the error is visible and the user can retry.
      setDrawerError(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onBackdropClick} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-detail-title"
        className="relative z-50 w-full max-w-md bg-white shadow-xl flex flex-col h-full focus:outline-none"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <h2 id="feedback-detail-title" className="text-base font-semibold text-slate-900">Feedback Detail</h2>
          <Button variant="icon" size="sm" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {drawerError && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <span className="flex-1">{drawerError}</span>
              <Button
                variant="icon"
                size="sm"
                aria-label="Dismiss error"
                className="shrink-0 text-red-400 hover:bg-red-100 hover:text-red-600"
                onClick={() => setDrawerError(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Title</label>
            <input
              aria-label="Feedback title"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Body */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
            <textarea
              aria-label="Feedback description"
              rows={5}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Add description…"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
            <select
              aria-label="Feedback detail type"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={type}
              onChange={(e) => setType(e.target.value as FeedbackType)}
            >
              <option value="feature_request">Feature Request</option>
              <option value="bug">Bug</option>
              <option value="general">General</option>
            </select>
          </div>

          {/* Status */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <select
              aria-label="Feedback detail status"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={status}
              onChange={(e) => setStatus(e.target.value as FeedbackStatus)}
            >
              {COLUMNS.map((col) => (
                <option key={col.status} value={col.status}>{col.label}</option>
              ))}
            </select>
          </div>

          {/* Customer */}
          {item.customer_id && (
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Customer</label>
              <p className="text-sm text-slate-700">
                {customerMap.get(item.customer_id) ?? item.customer_id}
              </p>
            </div>
          )}

          {/* Upvotes */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-600">Upvotes: <strong>{item.upvotes}</strong></span>
            <Button
              variant="ghost"
              size="sm"
              isLoading={upvoting}
              leftIcon={<ThumbsUp className="h-3 w-3" aria-hidden="true" />}
              className="bg-slate-100 text-slate-700 hover:bg-slate-200"
              onClick={upvote}
            >
              +1
            </Button>
          </div>

          {/* Created */}
          <p className="text-xs text-slate-500">
            Created {new Date(item.created_at).toLocaleString()}
          </p>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 space-y-2">
          {confirmDelete ? (
            // Inline confirm — keeps the destructive step inside the styled drawer
            // rather than dropping to a jarring native confirm() dialog.
            <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-2">
              <p className="text-sm font-medium text-red-800">Delete this feedback item?</p>
              <p className="text-xs text-red-700">This can't be undone.</p>
              {drawerError && (
                <p className="text-xs text-red-700 font-medium">{drawerError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  isLoading={deleting}
                  onClick={executeDelete}
                >
                  {deleting ? "Deleting…" : "Delete item"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={deleting}
                  onClick={() => { setConfirmDelete(false); setDrawerError(null); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="ghost"
              isLoading={deleting}
              leftIcon={<Trash2 className="h-4 w-4" />}
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
              disabled={confirmDelete}
              onClick={() => { setDrawerError(null); setConfirmDelete(true); }}
            >
              Delete
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                isLoading={saving}
                disabled={!title.trim()}
                onClick={save}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Item modal
// ---------------------------------------------------------------------------

interface AddModalProps {
  products: Product[];
  customers: Customer[];
  defaultProductId?: string;
  onClose: () => void;
}

function AddModal({ products, customers, defaultProductId, onClose }: AddModalProps) {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState(defaultProductId ?? products[0]?.id ?? "");
  const [type, setType] = useState<FeedbackType>("feature_request");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);

  const filteredCustomers = customers.filter(
    (c) =>
      !customerSearch ||
      c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
      (c.email ?? "").toLowerCase().includes(customerSearch.toLowerCase()),
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.post("feedback", {
        product_id: productId,
        type,
        title: title.trim(),
        body: body || undefined,
        customer_id: customerId || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["feedback"] });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onBackdropClick} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-add-title"
        className="relative z-50 bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 focus:outline-none"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 id="feedback-add-title" className="text-base font-semibold text-slate-900">Add Feedback</h2>
          <Button variant="icon" size="sm" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={submit} className="px-6 py-4 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <span className="flex-1">{error}</span>
              <Button
                type="button"
                variant="icon"
                size="sm"
                aria-label="Dismiss error"
                className="shrink-0 text-red-400 hover:bg-red-100 hover:text-red-600"
                onClick={() => setError(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}
          {/* Product */}
          <div>
            <label htmlFor="feedback-add-product" className="block text-xs font-medium text-slate-500 mb-1">Product</label>
            <select
              id="feedback-add-product"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              required
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Type */}
          <div>
            <label htmlFor="feedback-add-type" className="block text-xs font-medium text-slate-500 mb-1">Type</label>
            <select
              id="feedback-add-type"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={type}
              onChange={(e) => setType(e.target.value as FeedbackType)}
            >
              <option value="feature_request">Feature Request</option>
              <option value="bug">Bug</option>
              <option value="general">General</option>
            </select>
          </div>

          {/* Title */}
          <div>
            <label htmlFor="feedback-add-title-input" className="block text-xs font-medium text-slate-500 mb-1">Title *</label>
            <input
              id="feedback-add-title-input"
              required
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short description of the feedback"
            />
          </div>

          {/* Body */}
          <div>
            <label htmlFor="feedback-add-description" className="block text-xs font-medium text-slate-500 mb-1">Description</label>
            <textarea
              id="feedback-add-description"
              rows={3}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional details…"
            />
          </div>

          {/* Customer search (optional) */}
          <div>
            <label htmlFor="feedback-add-customer" className="block text-xs font-medium text-slate-500 mb-1">Customer (optional)</label>
            <input
              id="feedback-add-customer"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 mb-1"
              placeholder="Search by name or email…"
              value={customerSearch}
              onChange={(e) => {
                setCustomerSearch(e.target.value);
                setCustomerId("");
              }}
            />
            {customerSearch && filteredCustomers.length > 0 && (
              <div className="border border-slate-200 rounded-md max-h-36 overflow-y-auto">
                {filteredCustomers.slice(0, 8).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setCustomerId(c.id);
                      setCustomerSearch(c.name);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm hover:bg-slate-50",
                      customerId === c.id && "bg-slate-100 text-slate-900 font-medium",
                    )}
                  >
                    {c.name}
                    {c.email && <span className="text-slate-500 ml-2 text-xs">{c.email}</span>}
                  </button>
                ))}
              </div>
            )}
            {customerId && (
              <p className="text-xs text-green-600 mt-1">
                Linked to customer
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              isLoading={saving}
              disabled={!title.trim() || !productId}
            >
              Add Item
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Feedback page
// ---------------------------------------------------------------------------

export function Feedback() {
  const queryClient = useQueryClient();

  // State
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [draggingItem, setDraggingItem] = useState<FeedbackItem | null>(null);
  const [selectedItem, setSelectedItem] = useState<FeedbackItem | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [dragError, setDragError] = useState<string | null>(null);

  // Data
  const { data: productsData } = useProducts();
  const products = productsData ?? [];

  const effectiveProductId = selectedProductId || products[0]?.id || "";

  const feedbackQuery = useFeedbackItems(effectiveProductId, typeFilter);
  const { data: feedbackData, isLoading } = feedbackQuery;
  const items = feedbackData?.items ?? [];

  const { data: customersData } = useCustomers();
  const customers = customersData?.customers ?? [];

  const customerMap = new Map(customers.map((c) => [c.id, c.name]));

  // dnd-kit sensors. Keyboard drag uses Space to pick up / drop and Escape to
  // cancel — Enter is left free so it opens the card's detail drawer instead.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: ["Space"],
        cancel: ["Escape"],
        end: ["Space"],
      },
    }),
  );

  // Status mutation
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeedbackStatus }) =>
      api.patch(`feedback/${id}/status`, { status }),
    onMutate: async ({ id, status }) => {
      // Optimistic update
      setDragError(null);
      await queryClient.cancelQueries({ queryKey: ["feedback"] });
      const prev = queryClient.getQueryData<{ items: FeedbackItem[]; total: number }>(
        ["feedback", effectiveProductId, typeFilter],
      );
      if (prev) {
        queryClient.setQueryData(["feedback", effectiveProductId, typeFilter], {
          ...prev,
          items: prev.items.map((item) =>
            item.id === id ? { ...item, status } : item,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(["feedback", effectiveProductId, typeFilter], ctx.prev);
      }
      setDragError("Couldn't move that item — please try again.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["feedback"] });
    },
  });

  function handleDragStart(event: DragStartEvent) {
    const item = items.find((i) => i.id === event.active.id);
    if (item) setDraggingItem(item);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingItem(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Determine target status from over id
    let targetStatus: FeedbackStatus | null = null;

    // Check if dropped on a column sentinel
    const overId = String(over.id);
    if (overId.startsWith("col-")) {
      targetStatus = overId.replace("col-", "") as FeedbackStatus;
    } else {
      // Dropped on a card — use that card's column
      const overItem = items.find((i) => i.id === overId);
      if (overItem) targetStatus = overItem.status;
    }

    if (!targetStatus) return;

    const activeItem = items.find((i) => i.id === active.id);
    if (!activeItem || activeItem.status === targetStatus) return;

    statusMutation.mutate({ id: activeItem.id, status: targetStatus });
  }

  // Group items by status
  const byStatus = new Map<FeedbackStatus, FeedbackItem[]>();
  for (const col of COLUMNS) byStatus.set(col.status, []);
  for (const item of items) {
    const col = byStatus.get(item.status);
    if (col) col.push(item);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-semibold text-slate-900">Feedback</h1>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setShowAddModal(true)}
        >
          Add Item
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        {/* Product filter */}
        <select
          aria-label="Feedback product"
          className="border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          value={selectedProductId}
          onChange={(e) => setSelectedProductId(e.target.value)}
        >
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {/* Type filter */}
        <select
          aria-label="Feedback type filter"
          className="border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="all">All Types</option>
          <option value="feature_request">Feature Request</option>
          <option value="bug">Bug</option>
          <option value="general">General</option>
        </select>

        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
      </div>

      {/* Drag move failure */}
      {dragError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 mb-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <span>{dragError}</span>
          <button
            type="button"
            onClick={() => setDragError(null)}
            aria-label="Dismiss error"
            className="rounded p-0.5 hover:bg-red-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Kanban board */}
      {products.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
          No products found. Products are seeded from the Ventora operations repo — there's no feedback to display yet.
        </div>
      ) : !effectiveProductId ? (
        <div className="flex items-center justify-center flex-1 text-slate-600 text-sm">
          Select a product to view feedback.
        </div>
      ) : feedbackQuery.isError ? (
        <QueryError error={feedbackQuery.error} onRetry={() => void feedbackQuery.refetch()} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto pb-4 flex-1">
            {COLUMNS.map((col) => (
              <KanbanColumn
                key={col.status}
                status={col.status}
                label={col.label}
                items={byStatus.get(col.status) ?? []}
                customerMap={customerMap}
                onCardClick={setSelectedItem}
              />
            ))}
          </div>

          <DragOverlay>
            {draggingItem && (
              <FeedbackCard
                item={draggingItem}
                customerName={
                  draggingItem.customer_id ? customerMap.get(draggingItem.customer_id) : undefined
                }
                onClick={() => {}}
                overlay
              />
            )}
          </DragOverlay>
        </DndContext>
      )}

      {/* Detail drawer */}
      {selectedItem && (
        <DetailDrawer
          item={selectedItem}
          customerMap={customerMap}
          onClose={() => setSelectedItem(null)}
        />
      )}

      {/* Add modal */}
      {showAddModal && (
        <AddModal
          products={products}
          customers={customers}
          defaultProductId={effectiveProductId}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}
