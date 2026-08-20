import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, getErrorMessage } from "@admin/lib/api";
import { Copy, Check, ExternalLink, RefreshCw, X } from "lucide-react";
import { buildEmbedSnippet } from "./settings-embed";
import { Button } from "@admin/components/Button";
import { useModalDismiss } from "@admin/lib/useModalDismiss";

interface Product {
  id: string;
  name: string;
  slug: string;
  widget_public_key: string;
  origin_allowlist_json: string;
  brand_color: string | null;
  primary_domain: string | null;
}

const WIDGET_TYPES = [
  "wall-grid",
  "wall-carousel",
  "single-quote",
  "rating-badge",
  "feedback-button",
] as const;
type WidgetType = (typeof WIDGET_TYPES)[number];

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return { copied, copy };
}

interface NormalizeResult {
  origins: string[];
  invalid: string[];
}

export function normalizeOrigins(raw: string): NormalizeResult {
  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const origins: string[] = [];
  const invalid: string[] = [];

  for (const token of tokens) {
    // Reject userinfo (@ present) and scheme-relative URLs (starts with //) before parsing.
    if (token.includes("@") || token.startsWith("//")) {
      invalid.push(token);
      continue;
    }
    let candidate: string;
    try {
      const hasScheme = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(token);
      const urlStr = hasScheme ? token : `https://${token}`;
      const url = new URL(urlStr);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        invalid.push(token);
        continue;
      }
      // Reject any token that caused the URL parser to populate username or password.
      if (url.username !== "" || url.password !== "") {
        invalid.push(token);
        continue;
      }
      candidate = url.origin;
    } catch {
      invalid.push(token);
      continue;
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      origins.push(candidate);
    }
  }

  return { origins, invalid };
}

function originCount(json: string): number {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function originList(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]).join(", ") : "";
  } catch {
    return "";
  }
}

interface DrawerProps {
  product: Product;
  onClose: () => void;
}

function EditDrawer({ product, onClose }: DrawerProps) {
  const { dialogRef, onBackdropClick } = useModalDismiss<HTMLDivElement>(onClose);
  const qc = useQueryClient();
  const [brandColor, setBrandColor] = useState(product.brand_color ?? "");
  const [domain, setDomain] = useState(product.primary_domain ?? "");
  const [origins, setOrigins] = useState(originList(product.origin_allowlist_json));
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [regenKey, setRegenKey] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!saveSuccess) return;
    const t = setTimeout(() => setSaveSuccess(false), 2000);
    return () => clearTimeout(t);
  }, [saveSuccess]);

  const patchMutation = useMutation({
    mutationFn: (patch: Partial<{ brand_color: string | null; primary_domain: string | null; origin_allowlist_json: string }>) =>
      api.patch<Product>(`settings/products/${product.id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-products"] });
      setSaveSuccess(true);
      setSaveError(null);
    },
    onError: (err: unknown) => {
      setSaveError(getErrorMessage(err));
      setSaveSuccess(false);
    },
  });

  const regenMutation = useMutation({
    mutationFn: () => api.post<{ widget_public_key: string }>(`settings/products/${product.id}/regenerate-key`, {}),
    onSuccess: (data) => {
      setRegenKey(data.widget_public_key);
      setRegenError(null);
      setConfirmRegen(false);
      qc.invalidateQueries({ queryKey: ["settings-products"] });
    },
    onError: (err: unknown) => {
      setRegenError(getErrorMessage(err));
    },
  });

  const handleSave = () => {
    setSaveSuccess(false);
    setSaveError(null);
    const { origins: originArr, invalid } = normalizeOrigins(origins);
    if (invalid.length > 0) {
      setSaveError(
        `Invalid origin(s): ${invalid.join(", ")} — use full origins like https://example.com`,
      );
      return;
    }
    patchMutation.mutate({
      brand_color: brandColor.trim() || null,
      primary_domain: domain.trim() || null,
      origin_allowlist_json: JSON.stringify(originArr),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onBackdropClick} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-edit-title"
        className="relative z-10 bg-white w-full max-w-md shadow-xl flex flex-col h-full overflow-y-auto focus:outline-none"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 id="settings-edit-title" className="text-base font-semibold text-slate-900">{product.name}</h2>
          <Button variant="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 px-6 py-5 space-y-5">
          <div>
            <label htmlFor="settings-brand-color" className="block text-sm font-medium text-slate-700 mb-1">Brand Color</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={brandColor || "#4f46e5"}
                onChange={(e) => setBrandColor(e.target.value)}
                className="h-9 w-14 rounded border border-slate-300 cursor-pointer"
                aria-label="Brand color picker"
              />
              <input
                id="settings-brand-color"
                type="text"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                placeholder="#4f46e5"
                className="flex-1 border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
          </div>

          <div>
            <label htmlFor="settings-primary-domain" className="block text-sm font-medium text-slate-700 mb-1">Primary Domain</label>
            <input
              id="settings-primary-domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <div>
            <label htmlFor="settings-origin-allowlist" className="block text-sm font-medium text-slate-700 mb-1">
              Origin Allowlist
              <span className="ml-1 text-slate-500 font-normal">(comma-separated, empty = allow all)</span>
            </label>
            <textarea
              id="settings-origin-allowlist"
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              rows={3}
              placeholder="https://mysite.com, https://staging.mysite.com"
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 resize-y"
            />
          </div>

          {saveError && (
            <p className="text-sm text-red-600">{saveError}</p>
          )}
          {saveSuccess && (
            <p className="text-sm text-green-600">Saved.</p>
          )}

          <Button
            isLoading={patchMutation.isPending}
            className="w-full"
            onClick={handleSave}
          >
            {patchMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>

          <hr className="border-slate-200" />

          <div>
            <p className="text-sm font-medium text-slate-700 mb-1">Widget Key</p>
            <p className="text-sm font-mono text-slate-600 bg-slate-50 rounded px-3 py-2 select-all">
              {regenKey ?? maskKey(product.widget_public_key)}
            </p>
          </div>

          {!confirmRegen ? (
            <Button
              variant="ghost"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              className="text-red-600 hover:bg-red-50 hover:text-red-800"
              onClick={() => setConfirmRegen(true)}
            >
              Regenerate Key
            </Button>
          ) : (
            <div className="border border-red-200 rounded-md p-4 bg-red-50 space-y-3">
              <p className="text-sm text-red-700 font-medium">
                This will break existing embeds until updated.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="danger"
                  size="sm"
                  isLoading={regenMutation.isPending}
                  className="flex-1"
                  onClick={() => regenMutation.mutate()}
                >
                  {regenMutation.isPending ? "Regenerating..." : "Yes, Regenerate"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  onClick={() => setConfirmRegen(false)}
                >
                  Cancel
                </Button>
              </div>
              {regenError && (
                <p className="text-xs text-red-700">{regenError}</p>
              )}
              {regenKey && (
                <p className="text-xs text-green-700 font-mono break-all">
                  New key: {regenKey}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Settings() {
  const { data: products = [], isLoading } = useQuery<Product[]>({
    queryKey: ["settings-products"],
    queryFn: () => api.get<Product[]>("settings/products"),
  });

  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [selectedWidget, setSelectedWidget] = useState<WidgetType>("wall-grid");
  const { copied, copy } = useCopy();

  const selectedProduct = products.find((p) => p.id === selectedProductId) ?? products[0];

  const embedSnippet = selectedProduct
    ? buildEmbedSnippet(selectedProduct.widget_public_key, selectedWidget)
    : "";

  const previewUrl = selectedProduct
    ? `/preview/${selectedProduct.slug}/${selectedWidget}`
    : "";

  return (
    <div className="space-y-8 max-w-4xl">
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>

      {/* Products */}
      <section className="space-y-4">
        <h2 className="text-lg font-medium text-slate-900">Products</h2>

        {isLoading ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : products.length === 0 ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
            No products found. Products are seeded from the Ventora operations repo — run the seed step to populate them.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600">Domain</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600">Widget Key</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600">Color</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-600">Origins</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {products.map((p) => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    onEdit={() => setEditProduct(p)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Widget Preview */}
      <section className="space-y-4">
        <h2 className="text-lg font-medium text-slate-900">Widget Preview</h2>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label htmlFor="preview-product" className="block text-xs font-medium text-slate-600 mb-1">Product</label>
            <select
              id="preview-product"
              value={selectedProduct?.id ?? ""}
              onChange={(e) => setSelectedProductId(e.target.value)}
              className="border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="preview-widget" className="block text-xs font-medium text-slate-600 mb-1">Widget</label>
            <select
              id="preview-widget"
              value={selectedWidget}
              onChange={(e) => setSelectedWidget(e.target.value as WidgetType)}
              className="border border-slate-300 rounded-md px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {WIDGET_TYPES.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </div>
          {selectedProduct && (
            <Button
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              rightIcon={<ExternalLink className="h-3.5 w-3.5" />}
            >
              Open Preview
            </Button>
          )}
        </div>
      </section>

      {/* Embed Code */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium text-slate-900">Embed Code</h2>
        <div className="relative bg-slate-900 rounded-lg p-4">
          <pre className="text-sm text-green-300 overflow-x-auto whitespace-pre-wrap break-all pr-10">
            {embedSnippet}
          </pre>
          <Button
            variant="icon"
            size="sm"
            aria-label="Copy embed code"
            className="absolute top-3 right-3 text-slate-400 hover:bg-slate-700 hover:text-white"
            onClick={() => copy(embedSnippet)}
          >
            {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
          </Button>
        </div>
      </section>

      {editProduct && (
        <EditDrawer product={editProduct} onClose={() => setEditProduct(null)} />
      )}
    </div>
  );
}

interface ProductRowProps {
  product: Product;
  onEdit: () => void;
}

function ProductRow({ product, onEdit }: ProductRowProps) {
  const { copied, copy } = useCopy();

  return (
    <tr className="hover:bg-slate-50 transition-colors">
      <td className="px-4 py-3 font-medium text-slate-900">{product.name}</td>
      <td className="px-4 py-3 text-slate-600">{product.primary_domain ?? <span className="text-slate-500">—</span>}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-600">{maskKey(product.widget_public_key)}</span>
          <Button
            variant="icon"
            size="sm"
            aria-label="Copy widget key"
            onClick={() => copy(product.widget_public_key)}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </td>
      <td className="px-4 py-3">
        {product.brand_color ? (
          <div className="flex items-center gap-2">
            <div
              className="h-5 w-5 rounded border border-slate-200"
              style={{ backgroundColor: product.brand_color }}
            />
            <span className="text-xs font-mono text-slate-500">{product.brand_color}</span>
          </div>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-slate-600">
        {originCount(product.origin_allowlist_json) > 0 ? (
          <span>{originCount(product.origin_allowlist_json)} origin{originCount(product.origin_allowlist_json) !== 1 ? "s" : ""}</span>
        ) : (
          <span className="text-slate-500">All allowed</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          variant="ghost"
          size="sm"
          className="text-indigo-600 hover:bg-indigo-50 hover:text-indigo-800"
          onClick={onEdit}
        >
          Edit
        </Button>
      </td>
    </tr>
  );
}

function maskKey(key: string) {
  return "••••••••" + key.slice(-8);
}
