import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  Star,
  Trash2,
  ChevronDown,
  ChevronUp,
  X,
  Upload,
  Rss,
  FileText,
  PenLine,
} from "lucide-react";
import { api, getErrorMessage } from "@admin/lib/api";
import { QueryError } from "@admin/components/QueryError";
import {
  buildNormalizedReviewCsv,
  inferReviewCsvMapping,
  parseReviewCsvForMapping,
  type ParsedReviewCsv,
  type ReviewCsvField,
  type ReviewCsvMapping,
} from "@admin/lib/review-csv-import";
import { cn } from "@admin/lib/utils";
import { Button } from "@admin/components/Button";
import { ConfirmDialog } from "@admin/components/ConfirmDialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Product {
  id: string;
  name: string;
}

interface Customer {
  id: string;
  name: string;
  email: string | null;
}

interface CustomerListResponse {
  customers: Customer[];
  total: number;
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

interface ImportResult {
  inserted: number;
  skipped: number;
  errors?: string[];
}

type ConnectorSource = "rss" | "trustpilot" | "g2";

interface ConnectorConfig {
  id: string;
  product_id: string;
  source: ConnectorSource;
  config: Record<string, unknown>;
  enabled: boolean;
  last_polled_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  last_inserted: number | null;
}

interface ConnectorConfigListResponse {
  configs: ConnectorConfig[];
}

interface ConnectorTestRunResult extends ImportResult {
  fetched: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StarRating({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-gray-400 text-xs">No rating</span>;
  return (
    <span className="flex gap-0.5" role="img" aria-label={`${Math.round(rating)} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5",
            n <= Math.round(rating) ? "text-yellow-400 fill-yellow-400" : "text-gray-300",
          )}
        />
      ))}
    </span>
  );
}

const SOURCE_COLORS: Record<string, string> = {
  g2: "bg-orange-100 text-orange-700",
  trustpilot: "bg-green-100 text-green-700",
  capterra: "bg-blue-100 text-blue-700",
  app_store: "bg-sky-100 text-sky-700",
  play_store: "bg-emerald-100 text-emerald-700",
  twitter: "bg-cyan-100 text-cyan-700",
  product_hunt: "bg-rose-100 text-rose-700",
  rss: "bg-purple-100 text-purple-700",
  csv: "bg-gray-100 text-gray-700",
  manual: "bg-indigo-100 text-indigo-700",
};

function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={cn(
        "inline-block px-2 py-0.5 rounded text-xs font-medium capitalize",
        SOURCE_COLORS[source] ?? "bg-gray-100 text-gray-700",
      )}
    >
      {source.replace("_", " ")}
    </span>
  );
}

function Toast({
  result,
  onClose,
}: {
  result: ImportResult & { label: string };
  onClose: () => void;
}) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-start gap-3 bg-white border border-gray-200 rounded-lg shadow-lg p-4 max-w-sm animate-in slide-in-from-bottom-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900">{result.label} import done</p>
        <p className="text-sm text-gray-600 mt-0.5">
          Inserted <span className="font-medium text-green-700">{result.inserted}</span>, skipped{" "}
          <span className="font-medium text-gray-500">{result.skipped}</span> (deduped)
        </p>
        {result.errors && result.errors.length > 0 && (
          <p className="text-xs text-red-600 mt-1">{result.errors.length} error(s)</p>
        )}
      </div>
      <Button
        variant="icon"
        size="sm"
        aria-label="Dismiss"
        className="shrink-0"
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import tab types
// ---------------------------------------------------------------------------

type Tab = "manual" | "csv" | "rss" | "trustpilot" | "g2";

const TABS: { id: Tab; label: string; Icon: React.ElementType }[] = [
  { id: "manual", label: "Manual", Icon: PenLine },
  { id: "csv", label: "CSV", Icon: FileText },
  { id: "rss", label: "RSS Feed", Icon: Rss },
  { id: "trustpilot", label: "Trustpilot", Icon: Upload },
  { id: "g2", label: "G2", Icon: Upload },
];

const CSV_MAPPING_FIELDS: { field: ReviewCsvField; label: string; required: boolean }[] = [
  { field: "body", label: "Review Text", required: true },
  { field: "author_name", label: "Author Name", required: false },
  { field: "rating", label: "Rating", required: false },
  { field: "source_url", label: "Source URL", required: false },
];

const CONNECTOR_FIELDS: Record<ConnectorSource, { label: string; key: string; placeholder: string }> = {
  rss: {
    label: "RSS / Atom Feed URL",
    key: "feed_url",
    placeholder: "https://example.com/feed.xml",
  },
  trustpilot: {
    label: "Trustpilot Business Unit ID / Slug",
    key: "business_unit_id",
    placeholder: "yourcompany.com",
  },
  g2: {
    label: "G2 Product Slug",
    key: "product_slug",
    placeholder: "your-product",
  },
};

// ---------------------------------------------------------------------------
// Import Panel
// ---------------------------------------------------------------------------

function ImportPanel({
  products,
  onSuccess,
}: {
  products: Product[];
  onSuccess: (result: ImportResult, label: string, productId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("manual");
  const [productId, setProductId] = useState(products[0]?.id ?? "");

  // Manual form
  const [manualBody, setManualBody] = useState("");
  const [manualAuthor, setManualAuthor] = useState("");
  const [manualRating, setManualRating] = useState("");
  const [manualUrl, setManualUrl] = useState("");

  // CSV form
  const [csvText, setCsvText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [csvParsed, setCsvParsed] = useState<ParsedReviewCsv | null>(null);
  const [csvMapping, setCsvMapping] = useState<ReviewCsvMapping>({});

  // RSS form
  const [feedUrl, setFeedUrl] = useState("");

  // Trustpilot form
  const [tpBusinessId, setTpBusinessId] = useState("");

  // G2 form
  const [g2Slug, setG2Slug] = useState("");

  const submitManual = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("reviews/import/manual", {
        product_id: productId,
        body: manualBody,
        author_name: manualAuthor || undefined,
        rating: manualRating ? parseFloat(manualRating) : undefined,
        source_url: manualUrl || undefined,
      }),
    onSuccess: (data) => {
      onSuccess(data, "Manual", productId);
      setManualBody("");
      setManualAuthor("");
      setManualRating("");
      setManualUrl("");
    },
  });

  const submitCSV = useMutation({
    mutationFn: () => {
      const csv_text = csvParsed ? buildNormalizedReviewCsv(csvParsed, csvMapping) : csvText;

      return api.post<ImportResult>("reviews/import/csv", {
        product_id: productId,
        csv_text,
      });
    },
    onSuccess: (data) => {
      onSuccess(data, "CSV", productId);
      setCsvText("");
      setCsvFileName("");
      setCsvParsed(null);
      setCsvMapping({});
    },
  });

  const submitRSS = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("reviews/import/rss", {
        product_id: productId,
        feed_url: feedUrl,
      }),
    onSuccess: (data) => {
      onSuccess(data, "RSS", productId);
      setFeedUrl("");
    },
  });

  const submitTrustpilot = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("reviews/import/trustpilot", {
        product_id: productId,
        business_unit_id: tpBusinessId,
      }),
    onSuccess: (data) => {
      onSuccess(data, "Trustpilot", productId);
      setTpBusinessId("");
    },
  });

  const submitG2 = useMutation({
    mutationFn: () =>
      api.post<ImportResult>("reviews/import/g2", {
        product_id: productId,
        product_slug: g2Slug,
      }),
    onSuccess: (data) => {
      onSuccess(data, "G2", productId);
      setG2Slug("");
    },
  });

  const currentMutation = {
    manual: submitManual,
    csv: submitCSV,
    rss: submitRSS,
    trustpilot: submitTrustpilot,
    g2: submitG2,
  }[tab];

  const isSubmitting = currentMutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    currentMutation.mutate();
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const parsed = parseReviewCsvForMapping(text);

    setCsvText(text);
    setCsvFileName(file.name);
    setCsvParsed(parsed);
    setCsvMapping(inferReviewCsvMapping(parsed.headers));
  }

  function handleCsvTextChange(value: string) {
    setCsvText(value);
    setCsvFileName("");
    setCsvParsed(null);
    setCsvMapping({});
  }

  function updateCsvMapping(field: ReviewCsvField, header: string) {
    setCsvMapping((current) => ({
      ...current,
      [field]: header || undefined,
    }));
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
      {/* Tab bar */}
      <div className="flex px-4 pt-4 gap-1">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-full transition-colors",
              tab === id
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-100",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        {/* Product select — common to all tabs */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Product</label>
          <select
            aria-label="Import product"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Manual fields */}
        {tab === "manual" && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Review Text <span className="text-red-500">*</span>
              </label>
              <textarea
                required
                value={manualBody}
                onChange={(e) => setManualBody(e.target.value)}
                rows={4}
                placeholder="Write or paste the review text here…"
                aria-label="Review text"
                className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Author Name</label>
                <input
                  type="text"
                  value={manualAuthor}
                  onChange={(e) => setManualAuthor(e.target.value)}
                  placeholder="Jane Doe"
                  aria-label="Author name"
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Rating (1–5)
                </label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  step={0.5}
                  value={manualRating}
                  onChange={(e) => setManualRating(e.target.value)}
                  placeholder="5"
                  aria-label="Rating (1 to 5)"
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Source URL</label>
              <input
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="https://…"
                aria-label="Source URL"
                className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </>
        )}

        {/* CSV fields */}
        {tab === "csv" && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Upload CSV</label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleCsvUpload}
                className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
              />
              {csvFileName && (
                <p className="mt-1 text-xs text-gray-500">
                  {csvFileName} - {csvParsed?.rows.length ?? 0} data row(s)
                </p>
              )}
            </div>

            {csvParsed && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  {CSV_MAPPING_FIELDS.map(({ field, label, required }) => (
                    <div key={field}>
                      <label className="mb-1 block text-xs font-medium text-gray-700">
                        {label} {required && <span className="text-red-500">*</span>}
                      </label>
                      <select
                        required={Boolean(required)}
                        value={csvMapping[field] ?? ""}
                        onChange={(e) => updateCsvMapping(field, e.target.value)}
                        className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="">Do not import</option>
                        {csvParsed.headers.map((header, index) => (
                          <option key={`${header}-${index}`} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                {csvParsed.rows.length > 0 && (
                  <div className="mt-3 overflow-x-auto rounded border border-gray-200 bg-white">
                    <table className="min-w-full text-left text-xs">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          {csvParsed.headers.map((header, index) => (
                            <th key={`${header}-${index}`} className="px-2 py-1.5 font-medium">
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 text-gray-700">
                        {csvParsed.rows.slice(0, 3).map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {csvParsed.headers.map((header, index) => (
                              <td key={`${header}-${index}`} className="max-w-48 truncate px-2 py-1.5">
                                {row[index] || <span className="text-gray-300">Empty</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                CSV Text{" "}
                <span className="text-gray-400 font-normal">
                  (header: author_name, body, rating, source_url)
                </span>
              </label>
              <textarea
                aria-label="CSV Text"
                required
                value={csvText}
                onChange={(e) => handleCsvTextChange(e.target.value)}
                rows={8}
                placeholder={"author_name,body,rating,source_url\nJane Doe,Great product!,5,https://..."}
                className="w-full text-sm font-mono border border-gray-300 rounded-md px-3 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </>
        )}

        {/* RSS fields */}
        {tab === "rss" && (
          <div>
            <label htmlFor="rss-feed-url" className="block text-xs font-medium text-gray-700 mb-1">
              RSS / Atom Feed URL <span className="text-red-500">*</span>
            </label>
            <input
              id="rss-feed-url"
              required
              type="url"
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              placeholder="https://example.com/feed.xml"
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        )}

        {/* Trustpilot fields */}
        {tab === "trustpilot" && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Business Unit ID / Slug <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="text"
              value={tpBusinessId}
              onChange={(e) => setTpBusinessId(e.target.value)}
              placeholder="yourcompany.com"
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              The slug from{" "}
              <code className="bg-gray-100 px-1 rounded">trustpilot.com/review/yourcompany.com</code>
            </p>
          </div>
        )}

        {/* G2 fields */}
        {tab === "g2" && (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Product Slug <span className="text-red-500">*</span>
            </label>
            <input
              required
              type="text"
              value={g2Slug}
              onChange={(e) => setG2Slug(e.target.value)}
              placeholder="your-product"
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              The slug from{" "}
              <code className="bg-gray-100 px-1 rounded">g2.com/products/your-product/reviews</code>
            </p>
          </div>
        )}

        {/* Error */}
        {currentMutation.isError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {getErrorMessage(currentMutation.error)}
          </p>
        )}

        <Button
          type="submit"
          isLoading={isSubmitting}
          className="w-full"
        >
          {isSubmitting ? "Importing…" : "Import Reviews"}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connector Config Panel
// ---------------------------------------------------------------------------

function ConnectorConfigPanel({
  products,
  onSuccess,
}: {
  products: Product[];
  onSuccess: (result: ImportResult, label: string) => void;
}) {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [source, setSource] = useState<ConnectorSource>("rss");
  const [configValue, setConfigValue] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const configsQuery = useQuery({
    queryKey: ["review-connector-configs"],
    queryFn: () => api.get<ConnectorConfigListResponse>("reviews/connector-configs"),
  });
  const configs = configsQuery.data?.configs ?? [];

  const createConfig = useMutation({
    mutationFn: () => {
      const field = CONNECTOR_FIELDS[source];
      return api.post<ConnectorConfig>("reviews/connector-configs", {
        product_id: productId,
        source,
        config: { [field.key]: configValue.trim() },
        enabled,
      });
    },
    onMutate: () => {
      setError(null);
      setMessage(null);
    },
    onSuccess: () => {
      setConfigValue("");
      queryClient.invalidateQueries({ queryKey: ["review-connector-configs"] });
      setMessage("Connector saved");
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const deleteConfig = useMutation({
    mutationFn: (id: string) => api.delete(`reviews/connector-configs/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["review-connector-configs"] });
      setMessage("Connector deleted");
      setConfirmDeleteId(null);
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const toggleConfig = useMutation({
    mutationFn: ({ config, enabled }: { config: ConnectorConfig; enabled: boolean }) =>
      api.patch<ConnectorConfig>(`reviews/connector-configs/${config.id}`, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["review-connector-configs"] });
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const testRun = useMutation({
    mutationFn: (id: string) =>
      api.post<ConnectorTestRunResult>(`reviews/connector-configs/${id}/test-run`, {}),
    onMutate: () => {
      setError(null);
      setMessage(null);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["review-connector-configs"] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      onSuccess(data, "Connector test");
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const pollNow = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("reviews/connector-configs/poll-now", {}),
    onMutate: () => {
      setError(null);
      setMessage(null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["review-connector-configs"] });
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      setMessage("Polled all enabled connectors");
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createConfig.mutate();
  }

  function productName(id: string) {
    return products.find((product) => product.id === id)?.name ?? id;
  }

  function configDisplay(config: ConnectorConfig) {
    const key = CONNECTOR_FIELDS[config.source].key;
    const value = config.config[key];
    return typeof value === "string" ? value : String(value ?? "");
  }

  const activeField = CONNECTOR_FIELDS[source];

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Scheduled Connectors</h2>
          <p className="mt-1 text-sm text-gray-500">
            Configure RSS, Trustpilot, and G2 imports for the 6-hour poller.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          isLoading={pollNow.isPending}
          disabled={configs.length === 0}
          onClick={() => pollNow.mutate()}
        >
          {pollNow.isPending ? "Polling…" : "Poll now"}
        </Button>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,360px)_1fr]">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Product</label>
            <select
              aria-label="Connector product"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Source</label>
            <select
              aria-label="Connector source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value as ConnectorSource);
                setConfigValue("");
              }}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="rss">RSS Feed</option>
              <option value="trustpilot">Trustpilot</option>
              <option value="g2">G2</option>
            </select>
          </div>

          <div>
            <label htmlFor="connector-config-value" className="block text-xs font-medium text-gray-700 mb-1">
              {activeField.label} <span className="text-red-500">*</span>
            </label>
            <input
              id="connector-config-value"
              required
              type={source === "rss" ? "url" : "text"}
              value={configValue}
              onChange={(e) => setConfigValue(e.target.value)}
              placeholder={activeField.placeholder}
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Enabled for scheduled polling
          </label>

          {error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}
          {message && (
            <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              {message}
            </p>
          )}

          <Button
            type="submit"
            isLoading={createConfig.isPending}
            className="w-full"
          >
            {createConfig.isPending ? "Saving..." : "Save Connector"}
          </Button>
        </form>

        <div className="overflow-x-auto">
          {configsQuery.isLoading ? (
            <div className="rounded-md border border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
              Loading connectors...
            </div>
          ) : configs.length === 0 ? (
            <div className="rounded-md border border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
              No scheduled connectors configured.
            </div>
          ) : (
            <table className="w-full min-w-[680px] text-left">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">Source</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">Product</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">Config</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">Status</th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase text-gray-500">Enabled</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {configs.map((config) => (
                  <tr key={config.id} className="text-sm text-gray-700">
                    <td className="px-3 py-2">
                      <SourceBadge source={config.source} />
                    </td>
                    <td className="px-3 py-2">{productName(config.product_id)}</td>
                    <td className="max-w-56 truncate px-3 py-2 font-mono text-xs">
                      {configDisplay(config)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {config.last_status ? (
                        <span
                          className={cn(
                            "rounded px-2 py-0.5 font-medium",
                            config.last_status === "ok"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700",
                          )}
                        >
                          {config.last_status}
                        </span>
                      ) : (
                        <span className="text-gray-400">Not polled</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        onChange={(e) => toggleConfig.mutate({ config, enabled: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        title="Toggle scheduled polling"
                        aria-label="Toggle scheduled polling"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={!config.enabled}
                          isLoading={testRun.isPending}
                          onClick={() => testRun.mutate(config.id)}
                        >
                          {testRun.isPending ? "Testing…" : "Test"}
                        </Button>
                        {confirmDeleteId === config.id ? (
                          <>
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              isLoading={deleteConfig.isPending}
                              onClick={() => deleteConfig.mutate(config.id)}
                            >
                              Confirm delete
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => setConfirmDeleteId(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="icon"
                            size="sm"
                            aria-label="Delete connector"
                            title="Delete connector"
                            className="hover:bg-red-50 hover:text-red-600"
                            onClick={() => setConfirmDeleteId(config.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review Row
// ---------------------------------------------------------------------------

function ReviewRow({
  review,
  customers,
  isLinking,
  onLinkCustomer,
  onDelete,
}: {
  review: Review;
  customers: Customer[];
  isLinking: boolean;
  onLinkCustomer: (customerId: string | null, previousCustomerId: string | null) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const SHORT = 160;

  const isLong = review.body.length > SHORT;
  const displayBody = expanded || !isLong ? review.body : review.body.slice(0, SHORT) + "…";

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-sm text-gray-800 whitespace-nowrap">
        {review.author_name ?? <span className="text-gray-400 italic">Unknown</span>}
      </td>
      <td className="px-4 py-3 text-sm text-gray-700 max-w-xs">
        <p className="break-words">{displayBody}</p>
        {isLong && (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            className="mt-1 text-indigo-600 hover:bg-indigo-50 hover:text-indigo-800"
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? "Show less" : "Show more"}
          </Button>
        )}
      </td>
      <td className="px-4 py-3">
        <StarRating rating={review.rating} />
      </td>
      <td className="px-4 py-3">
        <SourceBadge source={review.source} />
      </td>
      <td className="px-4 py-3">
        <select
          value={review.customer_id ?? ""}
          disabled={isLinking}
          onChange={(e) => onLinkCustomer(e.target.value || null, review.customer_id)}
          aria-label="Link review to a customer"
          className="max-w-44 text-xs border border-gray-300 rounded-md px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60"
        >
          <option value="">Unlinked</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}{customer.email ? ` (${customer.email})` : ""}
            </option>
          ))}
        </select>
      </td>
      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
        {new Date(review.imported_at).toLocaleDateString()}
      </td>
      <td className="px-4 py-3">
        <Button
          variant="icon"
          size="sm"
          aria-label="Delete review"
          title="Delete review"
          className="hover:bg-red-50 hover:text-red-600"
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main Reviews page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

// Only sources the CRM can currently produce; capterra/app_store/play_store/twitter/product_hunt are type-only future sources.
const SELECTABLE_SOURCES = ["manual", "csv", "rss", "g2", "trustpilot"] as const;

export function Reviews() {
  const queryClient = useQueryClient();

  const [selectedProduct, setSelectedProduct] = useState<string>("");
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [page, setPage] = useState(0);
  const [toast, setToast] = useState<(ImportResult & { label: string }) | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Products list
  const { data: productsData } = useQuery({
    queryKey: ["products"],
    queryFn: () => api.get<Product[]>("settings/products"),
  });
  const products = productsData ?? [];

  const { data: customersData } = useQuery({
    queryKey: ["customers", "review-link-picker"],
    queryFn: () => api.get<CustomerListResponse>("customers?limit=500"),
  });
  const customers = customersData?.customers ?? [];

  // Set default product once loaded
  const effectiveProduct = selectedProduct || products[0]?.id || "";

  // Reset to page 0 whenever product or source filter changes.
  useEffect(() => {
    setPage(0);
  }, [effectiveProduct, selectedSource]);

  // Reviews list
  const reviewsQuery = useQuery({
    queryKey: ["reviews", effectiveProduct, selectedSource, page],
    queryFn: () =>
      api.get<{ reviews: Review[]; total: number }>(
        `reviews?product_id=${effectiveProduct}${selectedSource ? `&source=${selectedSource}` : ""}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
    enabled: !!effectiveProduct,
    placeholderData: keepPreviousData,
  });

  const reviews = reviewsQuery.data?.reviews ?? [];
  const total = reviewsQuery.data?.total ?? 0;

  const deleteReview = useMutation({
    mutationFn: (id: string) => api.delete(`reviews/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      setConfirmDeleteId(null);
    },
    onError: (err: unknown) => {
      // Keep the confirm dialog open so the error shows inline and the user can retry.
      setDeleteError(getErrorMessage(err));
    },
  });

  const linkReview = useMutation({
    mutationFn: ({ id, customerId }: { id: string; customerId: string | null; previousCustomerId: string | null }) =>
      api.patch<Review>(`reviews/${id}`, { customer_id: customerId }),
    onMutate: () => {
      setLinkError(null);
    },
    onSuccess: (_updated, variables) => {
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      if (variables.customerId) {
        queryClient.invalidateQueries({ queryKey: ["customer", variables.customerId] });
      }
      if (variables.previousCustomerId && variables.previousCustomerId !== variables.customerId) {
        queryClient.invalidateQueries({ queryKey: ["customer", variables.previousCustomerId] });
      }
    },
    onError: (err: unknown) => {
      setLinkError(getErrorMessage(err));
    },
  });

  function handleImportSuccess(result: ImportResult, label: string, productId?: string) {
    setToast({ ...result, label });
    // Point the "Imported Reviews" list at the product we just imported into,
    // so the freshly added rows are visible instead of whatever product the
    // filter happened to default to.
    if (productId) setSelectedProduct(productId);
    queryClient.invalidateQueries({ queryKey: ["reviews"] });
  }

  // Auto-dismiss the toast after 5s; clean up the timer if the toast changes or
  // the component unmounts so we never setState on an unmounted component.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Reviews Import</h1>
        <p className="mt-1 text-sm text-gray-500">
          Import and manage reviews from multiple sources. Duplicates are automatically skipped.
        </p>
      </div>

      {/* Import panel */}
      {products.length > 0 ? (
        <>
          <ImportPanel products={products} onSuccess={handleImportSuccess} />
          <ConnectorConfigPanel products={products} onSuccess={handleImportSuccess} />
        </>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
          No products found. Add a product in Settings before importing reviews.
        </div>
      )}

      {/* Filters + results table */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900">Imported Reviews</h2>
            {total > 0 && (
              <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium">
                {total}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Product filter */}
            <select
              aria-label="Reviews product filter"
              value={effectiveProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}
              className="text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            {/* Source filter */}
            <select
              aria-label="Reviews source filter"
              value={selectedSource}
              onChange={(e) => setSelectedSource(e.target.value)}
              className="text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">All sources</option>
              {SELECTABLE_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>

        {reviewsQuery.isError ? (
          <QueryError
            error={reviewsQuery.error}
            onRetry={() => void reviewsQuery.refetch()}
            className="m-5 border-0 bg-transparent"
          />
        ) : reviewsQuery.isLoading ? (
          <div className="px-5 py-10 text-center text-gray-400 text-sm">Loading reviews…</div>
        ) : reviews.length === 0 ? (
          <div className="px-5 py-10 text-center text-gray-400 text-sm">
            No reviews yet. Use the import panel above to add some.
          </div>
        ) : (
          <>
            {linkError && (
              <div className="mx-5 mt-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                <span className="flex-1">{linkError}</span>
                <Button
                  variant="icon"
                  size="sm"
                  aria-label="Dismiss error"
                  className="shrink-0 text-red-400 hover:bg-red-100 hover:text-red-600"
                  onClick={() => setLinkError(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/60">
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">
                      Author
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      Review
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                      Rating
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                      Source
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-48">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">
                      Imported
                    </th>
                    <th className="px-4 py-3 w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {reviews.map((review) => (
                    <ReviewRow
                      key={review.id}
                      review={review}
                      customers={customers}
                      isLinking={linkReview.isPending}
                      onLinkCustomer={(customerId, previousCustomerId) => linkReview.mutate({ id: review.id, customerId, previousCustomerId })}
                      onDelete={() => {
                        setDeleteError(null);
                        setConfirmDeleteId(review.id);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100">
                <span className="text-xs text-gray-500">
                  Showing {total === 0 ? 0 : page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Previous page"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Prev
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label="Next page"
                    disabled={(page + 1) * PAGE_SIZE >= total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {confirmDeleteId && (
        <ConfirmDialog
          title="Delete review"
          message="This permanently removes the review. This can't be undone."
          confirmLabel="Delete"
          isConfirming={deleteReview.isPending}
          error={deleteError}
          onConfirm={() => deleteReview.mutate(confirmDeleteId)}
          onClose={() => {
            setConfirmDeleteId(null);
            setDeleteError(null);
          }}
        />
      )}

      {/* Toast */}
      {toast && <Toast result={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
