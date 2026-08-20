/**
 * Typed API error thrown by every admin fetch helper.
 *
 * Backend admin routes (`src/routes/admin/*.ts`) return JSON error bodies shaped
 * like `{ error: "human message" }` and, for machine-readable cases, additionally
 * `{ error: "...", code: "FIREWALL_VIOLATION" }`. ApiError surfaces all three:
 * the HTTP `status`, the optional machine `code`, and the raw parsed `body` — while
 * remaining a real `Error` (correct `instanceof`, stack trace, Sentry-friendly).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body: unknown;

  constructor(message: string, opts: { status: number; code?: string; body?: unknown }) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/** Consistent display string for any thrown value. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "error" in err) {
    const msg = (err as { error?: unknown }).error;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return "Something went wrong.";
}

const ADMIN_CSRF_HEADER = "X-Ventora-CSRF";
const ACCESS_AJAX_HEADER = "X-Requested-With";

/**
 * Build an ApiError from a non-ok Response, draining the body once for both the
 * message and any machine `code`. Falls back to text, then statusText.
 */
async function errorFromResponse(res: Response): Promise<ApiError> {
  let message = res.statusText;
  let code: string | undefined;
  let body: unknown;

  const raw = await res.text().catch(() => "");
  if (raw.trim()) {
    try {
      const json = JSON.parse(raw) as { error?: unknown; code?: unknown };
      body = json;
      if (typeof json.error === "string" && json.error.trim()) message = json.error;
      if (typeof json.code === "string") code = json.code;
    } catch {
      // Non-JSON body — use the raw text as the message.
      body = raw;
      message = raw.trim();
    }
  }

  return new ApiError(message, { status: res.status, code, body });
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `/api/admin/${path.replace(/^\//, "")}`;
  const headers: Record<string, string> = { [ACCESS_AJAX_HEADER]: "XMLHttpRequest" };
  if (method !== "GET") headers[ADMIN_CSRF_HEADER] = "1";
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw await errorFromResponse(res);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function upload<T>(path: string, file: File): Promise<T> {
  const url = `/api/admin/${path.replace(/^\//, "")}`;
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(url, {
    method: "POST",
    headers: { [ACCESS_AJAX_HEADER]: "XMLHttpRequest", [ADMIN_CSRF_HEADER]: "1" },
    body: form,
  });

  if (!res.ok) {
    throw await errorFromResponse(res);
  }

  // Media route returns 201 JSON, but tolerate empty/non-JSON bodies defensively.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  get<T>(path: string) {
    return request<T>("GET", path);
  },
  post<T>(path: string, body: unknown) {
    return request<T>("POST", path, body);
  },
  patch<T>(path: string, body: unknown) {
    return request<T>("PATCH", path, body);
  },
  delete(path: string) {
    return request<void>("DELETE", path);
  },
  upload<T>(path: string, file: File) {
    return upload<T>(path, file);
  },
};
