/**
 * Server-to-server HMAC verification for AI-SDR lead ingest.
 *
 * The AI-SDR worker (a separate Cloudflare Worker) POSTs qualified leads to this
 * CRM, signed with HMAC-SHA256 over a canonical payload. The canonical signer
 * lives in a private shared package that is never published to npm, so it cannot
 * be imported here. This module re-implements the verify side with byte-for-byte
 * parity, proven by the fixture test in `tests/unit/sdr-hmac.test.ts`.
 *
 * The CRM runs on Cloudflare Workers, so all hashing/signing uses WebCrypto
 * (`crypto.subtle`) rather than a hand-rolled SHA-256. The signed payload format
 * and key sorting match the platform signer exactly.
 *
 * The worker sends these headers (consumed by the ingest route in a later task):
 *   X-Ventora-Signature, X-Ventora-Timestamp, X-Ventora-Nonce.
 * Replay / nonce-store protection is a later task and out of scope here; the
 * nonce is still folded into the signed payload so it is tamper-protected.
 */

/** JSON value shape accepted by the canonical stable serializer. */
export type StableJsonValue =
  | string
  | number
  | boolean
  | null
  | StableJsonValue[]
  | { [key: string]: StableJsonValue };

/** Outcome of an HMAC verification attempt. */
export type HmacVerificationResult =
  | { ok: true }
  | { ok: false; reason: "malformed_signature" | "invalid_signature" | "timestamp_skew" };

/** Default clock skew tolerance for signed timestamps: 5 minutes. */
export const DEFAULT_MAX_SKEW_MS = 300_000;

/** A lowercase 64-char hex string — the shape of a SHA-256 HMAC digest. */
const HEX_SIGNATURE_RE = /^[a-f0-9]{64}$/;

const encoder = new TextEncoder();

/**
 * Recursively key-sorted JSON serialization. Arrays preserve order; object keys
 * are sorted lexicographically; keys whose value is `undefined` are dropped;
 * `null` and primitives pass through unchanged. Must match the platform signer.
 */
export function stableJson(value: StableJsonValue): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: StableJsonValue): StableJsonValue {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const source = value as { [key: string]: StableJsonValue };
  const sorted: { [key: string]: StableJsonValue } = {};
  for (const key of Object.keys(source).sort()) {
    const child = source[key];
    if (child !== undefined) {
      sorted[key] = sortValue(child);
    }
  }
  return sorted;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Lowercase hex of SHA-256 over the UTF-8 bytes of `value`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(digest);
}

interface BuildHmacPayloadInput {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: StableJsonValue;
}

/**
 * Build the canonical string that gets signed:
 *   `${timestamp}.${nonce}.${METHOD}.${path}.${sha256Hex(stableJson(body))}`
 */
export async function buildHmacPayload(input: BuildHmacPayloadInput): Promise<string> {
  const bodyHash = await sha256Hex(stableJson(input.body));
  return `${input.timestamp}.${input.nonce}.${input.method.toUpperCase()}.${input.path}.${bodyHash}`;
}

/** Lowercase hex of HMAC-SHA256(key=utf8(secret), msg=utf8(payload)). */
export async function signHmacPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toHex(signature);
}

/**
 * Length-safe constant-time string comparison. Folds the length difference and
 * every char-code XOR into a single accumulator over the longer string, so the
 * loop never short-circuits on the first differing byte and a length mismatch
 * cannot be distinguished from a content mismatch by timing. Mirrors the
 * canonical platform `constantTimeEqualHex`.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Resolve a timestamp to epoch ms. Numbers and numeric strings (the worker sends
 * `String(Date.now())`) are taken as epoch ms directly; other strings fall back
 * to `Date.parse` for ISO dates. Returns NaN for unparseable input.
 */
function parseTimestampMs(timestamp: number | string): number {
  if (typeof timestamp === "number") {
    return timestamp;
  }
  const trimmed = timestamp.trim();
  if (trimmed !== "" && /^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return Date.parse(timestamp);
}

interface VerifyHmacSignatureInput {
  payload: string;
  signature: string;
  secret: string;
  /** Defaults to `Date.now()` when a `timestamp` is supplied. */
  nowMs?: number;
  /** Epoch ms (number or numeric string) or ISO date string. Omit to skip skew check. */
  timestamp?: number | string;
  /** Defaults to 5 minutes. */
  maxSkewMs?: number;
}

/**
 * Verify a precomputed canonical payload against its signature, with an optional
 * timestamp-skew check. The skew check (when a timestamp is provided) runs before
 * the cryptographic comparison so an expired request is cheaply rejected.
 */
export async function verifyHmacSignature(
  input: VerifyHmacSignatureInput,
): Promise<HmacVerificationResult> {
  if (!HEX_SIGNATURE_RE.test(input.signature)) {
    return { ok: false, reason: "malformed_signature" };
  }

  if (input.timestamp !== undefined) {
    const nowMs = input.nowMs ?? Date.now();
    const maxSkewMs = input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
    const timestampMs = parseTimestampMs(input.timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > maxSkewMs) {
      return { ok: false, reason: "timestamp_skew" };
    }
  }

  const expected = await signHmacPayload(input.payload, input.secret);
  if (!constantTimeEqual(expected, input.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}

interface VerifySdrIngestRequestInput {
  secret: string;
  method: string;
  path: string;
  body: StableJsonValue;
  signature: string;
  /** Signed nonce; folded into the canonical payload (replay store is a later task). */
  nonce: string;
  /** Epoch ms (number or numeric string) or ISO date string. Omit to skip skew check. */
  timestamp?: number | string;
  nowMs?: number;
  maxSkewMs?: number;
}

/**
 * Convenience entry point for the ingest route: rebuilds the canonical payload
 * from the request parts and verifies it against the supplied signature.
 */
export async function verifySdrIngestRequest(
  input: VerifySdrIngestRequestInput,
): Promise<HmacVerificationResult> {
  const timestampForPayload = input.timestamp ?? "";
  const payload = await buildHmacPayload({
    timestamp: String(timestampForPayload),
    nonce: input.nonce,
    method: input.method,
    path: input.path,
    body: input.body,
  });
  return verifyHmacSignature({
    payload,
    signature: input.signature,
    secret: input.secret,
    timestamp: input.timestamp,
    nowMs: input.nowMs,
    maxSkewMs: input.maxSkewMs,
  });
}
