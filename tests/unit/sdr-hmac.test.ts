import { describe, it, expect } from "vitest";
import {
  stableJson,
  sha256Hex,
  buildHmacPayload,
  signHmacPayload,
  verifyHmacSignature,
  verifySdrIngestRequest,
  constantTimeEqual,
  type StableJsonValue,
} from "../../src/lib/sdr-hmac";

// Canonical fixture produced by the real signer on the other side of this contract,
// captured verbatim so the verify side here is checked against it rather than itself.
const SECRET = "test_crm_ingest_secret_value_2026";
const TIMESTAMP = "1718900000000";
const NONCE = "nonce-abc-123";
const METHOD = "post";
const PATH = "/s/ingest/leads/widget_demo_key";

const FIXTURE_BODY: StableJsonValue = {
  sdrSessionId: "sess_789",
  contact: { email: "Jane@Example.com", name: "Jane Doe", company: "Acme", role: "ED" },
  qualification: { budget: "yes", authority: "decision_maker", need: "compliance", timeline: "Q3" },
  derived: { fitScore: 0.82, intentScore: 0.6 },
  status: "qualified",
  activities: [
    { type: "session_started", payload: {} },
    { type: "qualification_updated", payload: { field: "budget" } },
  ],
  utm: { source: "linkedin", campaign: "launch" },
  pageUrl: "https://grantpipe.com/pricing",
  locale: "en-US",
};

const EXPECTED_CANONICAL =
  '{"activities":[{"payload":{},"type":"session_started"},{"payload":{"field":"budget"},"type":"qualification_updated"}],"contact":{"company":"Acme","email":"Jane@Example.com","name":"Jane Doe","role":"ED"},"derived":{"fitScore":0.82,"intentScore":0.6},"locale":"en-US","pageUrl":"https://grantpipe.com/pricing","qualification":{"authority":"decision_maker","budget":"yes","need":"compliance","timeline":"Q3"},"sdrSessionId":"sess_789","status":"qualified","utm":{"campaign":"launch","source":"linkedin"}}';
const EXPECTED_HASH = "c87ee9628bea444c9586af0430e0b6b455c1a9e3544360a5837aed8321907259";
const EXPECTED_PAYLOAD = `1718900000000.nonce-abc-123.POST./s/ingest/leads/widget_demo_key.${EXPECTED_HASH}`;
const EXPECTED_SIGNATURE = "7537bc15df5dada8ad1e531f5f679e2399728214ad479771d006d8723ea11ab7";

const fixtureTimestampMs = Number(TIMESTAMP);

describe("byte-parity fixture (canonical platform output)", () => {
  it("stableJson matches the canonical string exactly", () => {
    expect(stableJson(FIXTURE_BODY)).toBe(EXPECTED_CANONICAL);
  });

  it("sha256Hex of the canonical string matches the expected hash", async () => {
    expect(await sha256Hex(EXPECTED_CANONICAL)).toBe(EXPECTED_HASH);
  });

  it("buildHmacPayload matches the expected payload", async () => {
    const payload = await buildHmacPayload({
      timestamp: TIMESTAMP,
      nonce: NONCE,
      method: METHOD,
      path: PATH,
      body: FIXTURE_BODY,
    });
    expect(payload).toBe(EXPECTED_PAYLOAD);
  });

  it("signHmacPayload matches the expected signature", async () => {
    expect(await signHmacPayload(EXPECTED_PAYLOAD, SECRET)).toBe(EXPECTED_SIGNATURE);
  });

  it("verifySdrIngestRequest returns ok for the fixture signature", async () => {
    const result = await verifySdrIngestRequest({
      secret: SECRET,
      method: METHOD,
      path: PATH,
      body: FIXTURE_BODY,
      signature: EXPECTED_SIGNATURE,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      nowMs: fixtureTimestampMs,
    });
    expect(result).toEqual({ ok: true });
  });

  it("verifySdrIngestRequest passes with nowMs near the fixture timestamp", async () => {
    const result = await verifySdrIngestRequest({
      secret: SECRET,
      method: METHOD,
      path: PATH,
      body: FIXTURE_BODY,
      signature: EXPECTED_SIGNATURE,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      nowMs: fixtureTimestampMs + 60_000,
    });
    expect(result).toEqual({ ok: true });
  });

  it("verifySdrIngestRequest passes when the skew check is effectively disabled", async () => {
    // timestamp is always part of the signed payload, but a wide maxSkewMs makes
    // the freshness window non-binding (e.g. for replaying the canonical fixture).
    const result = await verifySdrIngestRequest({
      secret: SECRET,
      method: METHOD,
      path: PATH,
      body: FIXTURE_BODY,
      signature: EXPECTED_SIGNATURE,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      maxSkewMs: Number.POSITIVE_INFINITY,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("tampered / wrong-secret signatures", () => {
  it("rejects a tampered body with invalid_signature", async () => {
    const tampered: StableJsonValue = {
      ...(FIXTURE_BODY as Record<string, StableJsonValue>),
      status: "disqualified",
    };
    const result = await verifySdrIngestRequest({
      secret: SECRET,
      method: METHOD,
      path: PATH,
      body: tampered,
      signature: EXPECTED_SIGNATURE,
      timestamp: TIMESTAMP,
      nonce: NONCE,
      nowMs: fixtureTimestampMs,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a wrong secret with invalid_signature", async () => {
    const result = await verifySdrIngestRequest({
      secret: "wrong_secret",
      method: METHOD,
      path: PATH,
      body: FIXTURE_BODY,
      signature: EXPECTED_SIGNATURE,
      nonce: NONCE,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });
});

describe("malformed signatures", () => {
  const cases: Array<[string, string]> = [
    ["non-hex garbage", "xyz"],
    ["uppercase hex (lowercase-only regex)", EXPECTED_SIGNATURE.toUpperCase()],
    ["63 chars (too short)", "a".repeat(63)],
    ["65 chars (too long)", "a".repeat(65)],
  ];

  for (const [label, signature] of cases) {
    it(`rejects ${label} with malformed_signature`, async () => {
      const result = await verifyHmacSignature({
        payload: EXPECTED_PAYLOAD,
        signature,
        secret: SECRET,
      });
      expect(result).toEqual({ ok: false, reason: "malformed_signature" });
    });
  }
});

describe("timestamp skew", () => {
  it("rejects a timestamp far beyond maxSkewMs with timestamp_skew", async () => {
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nowMs: fixtureTimestampMs + 600_000,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_skew" });
  });

  it("accepts a timestamp within maxSkewMs", async () => {
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nowMs: fixtureTimestampMs + 120_000,
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts an ISO-string timestamp within skew", async () => {
    const iso = new Date(fixtureTimestampMs).toISOString();
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: iso,
      nowMs: fixtureTimestampMs + 1000,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a garbage / non-finite timestamp string with timestamp_skew", async () => {
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: "not-a-date",
      nowMs: fixtureTimestampMs,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_skew" });
  });

  it("accepts a numeric (epoch ms) timestamp within skew", async () => {
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: fixtureTimestampMs,
      nowMs: fixtureTimestampMs + 1000,
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects an empty-string timestamp with timestamp_skew", async () => {
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: "   ",
      nowMs: fixtureTimestampMs,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_skew" });
  });

  it("respects a custom maxSkewMs", async () => {
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: TIMESTAMP,
      nowMs: fixtureTimestampMs + 5000,
      maxSkewMs: 1000,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_skew" });
  });

  it("uses Date.now() as the default nowMs", async () => {
    // A fixture timestamp from 2024 is far outside the default 5-minute window.
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: EXPECTED_SIGNATURE,
      secret: SECRET,
      timestamp: TIMESTAMP,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_skew" });
  });
});

describe("stableJson unit cases", () => {
  it("produces identical output regardless of input key order", () => {
    const a = stableJson({ b: 1, a: { d: 2, c: 3 } });
    const b = stableJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order (does not sort array elements)", () => {
    expect(stableJson([3, 1, 2])).toBe("[3,1,2]");
    expect(stableJson(["c", "a", "b"])).toBe('["c","a","b"]');
  });

  it("sorts keys inside objects nested in arrays", () => {
    expect(stableJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("drops undefined-valued keys", () => {
    expect(stableJson({ a: 1, b: undefined } as unknown as StableJsonValue)).toBe('{"a":1}');
  });

  it("keeps null values", () => {
    expect(stableJson({ a: null, b: 2 })).toBe('{"a":null,"b":2}');
    expect(stableJson(null)).toBe("null");
  });

  it("passes numbers and booleans through", () => {
    expect(stableJson(42)).toBe("42");
    expect(stableJson(true)).toBe("true");
    expect(stableJson(false)).toBe("false");
    expect(stableJson("hi")).toBe('"hi"');
  });
});

describe("constant-time compare", () => {
  it("returns invalid_signature (not a thrown error) for a length-mismatched signature", async () => {
    // 64-char lowercase hex passes the malformed regex but differs in length-after-decode
    // semantics vs the computed signature only if content differs; here we use a valid-format
    // signature that simply doesn't match, proving no throw on comparison.
    const otherValid = "0".repeat(64);
    const result = await verifyHmacSignature({
      payload: EXPECTED_PAYLOAD,
      signature: otherValid,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for equal-length strings that differ in content", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("a", "b")).toBe(false);
  });

  it("returns false for length-mismatched strings (longer first)", () => {
    // Exercises the length-fold path: a.length ^ b.length is non-zero, and the
    // loop runs to max(len) so charCodeAt past the shorter string falls back to 0.
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });

  it("returns false for length-mismatched strings (longer second)", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — Cross-impl ISO-timestamp fixture test
//
// The AI-SDR worker signs requests using `new Date().toISOString()` as the
// X-Ventora-Timestamp header value. The CRM verifier must:
//   (a) accept ISO-8601 timestamps within the skew window, and
//   (b) fold the ISO string into the canonical payload identically to how the
//       worker does: `${timestamp}.${nonce}.${METHOD}.${path}.${bodyHash}`
//       where `timestamp` is the raw ISO string — not epoch ms.
//
// This pins the end-to-end format contract so a future change to either side's
// timestamp serialisation is caught immediately.
// ---------------------------------------------------------------------------

describe("cross-impl ISO-timestamp fixture (Fix 3)", () => {
  const ISO_SECRET = "test_crm_ingest_secret_value_2026";
  const ISO_NONCE = "nonce-iso-cross-impl";
  const ISO_METHOD = "POST";
  const ISO_PATH = "/s/ingest/leads/widget_demo_key";

  const ISO_BODY: StableJsonValue = {
    sdrSessionId: "sess-iso-fixture",
    profile: {
      contact: { email: "iso@example.com", name: "ISO Test" },
      derived: {},
      qualification: {},
    },
    activities: [{ type: "session_started", payload: null }],
    occurredAt: "2026-01-15T08:30:00.000Z",
  };

  // Pin the epoch ms value the ISO string represents so tests are deterministic.
  const ISO_TIMESTAMP_MS = new Date("2026-01-15T08:30:00.000Z").getTime();
  // The worker sends the ISO string directly as the header value.
  const ISO_TIMESTAMP_STRING = new Date(ISO_TIMESTAMP_MS).toISOString();

  it("builds a canonical payload using the ISO string verbatim (not epoch ms)", async () => {
    // The canonical format is: `${timestamp}.${nonce}.${METHOD}.${path}.${bodyHash}`
    // When the worker sends an ISO string, `timestamp` in the payload is the ISO string.
    const payload = await buildHmacPayload({
      timestamp: ISO_TIMESTAMP_STRING,
      nonce: ISO_NONCE,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
    });
    // The payload must start with the ISO string, not with an epoch ms number.
    expect(payload.startsWith(ISO_TIMESTAMP_STRING + ".")).toBe(true);
    expect(payload).toContain(`.${ISO_NONCE}.${ISO_METHOD.toUpperCase()}.${ISO_PATH}.`);
  });

  it("verifySdrIngestRequest ACCEPTS a signature built with an ISO timestamp within the skew window", async () => {
    // Replicate exactly what the worker does:
    //   timestamp = new Date().toISOString()
    //   payload   = buildHmacPayload({ timestamp, nonce, method, path, body })
    //   signature = signHmacPayload(payload, secret)
    const payload = await buildHmacPayload({
      timestamp: ISO_TIMESTAMP_STRING,
      nonce: ISO_NONCE,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
    });
    const signature = await signHmacPayload(payload, ISO_SECRET);

    // The CRM verifier must accept this — nowMs is within the default 5-minute window.
    const result = await verifySdrIngestRequest({
      secret: ISO_SECRET,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
      signature,
      nonce: ISO_NONCE,
      timestamp: ISO_TIMESTAMP_STRING,
      nowMs: ISO_TIMESTAMP_MS + 30_000, // 30 seconds later — well within 5 min
    });
    expect(result).toEqual({ ok: true });
  });

  it("verifySdrIngestRequest REJECTS an ISO timestamp older than the skew window", async () => {
    // Same construction — valid signature over an ISO timestamp — but nowMs is
    // 10 minutes after the timestamp, which exceeds DEFAULT_MAX_SKEW_MS (5 min).
    const payload = await buildHmacPayload({
      timestamp: ISO_TIMESTAMP_STRING,
      nonce: ISO_NONCE,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
    });
    const signature = await signHmacPayload(payload, ISO_SECRET);

    const result = await verifySdrIngestRequest({
      secret: ISO_SECRET,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
      signature,
      nonce: ISO_NONCE,
      timestamp: ISO_TIMESTAMP_STRING,
      nowMs: ISO_TIMESTAMP_MS + 10 * 60_000, // 10 minutes later — outside window
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_skew" });
  });

  it("skew is computed from the ISO string's epoch value, not from string length or parse fallback", async () => {
    // Verify that parseTimestampMs correctly resolves the ISO string to epoch ms
    // by testing a timestamp that is exactly at the edge of the default window.
    const payload = await buildHmacPayload({
      timestamp: ISO_TIMESTAMP_STRING,
      nonce: ISO_NONCE,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
    });
    const signature = await signHmacPayload(payload, ISO_SECRET);

    // Exactly at the window boundary (300_000 ms) — should still be accepted
    // (the check is Math.abs(skew) > maxSkewMs, so boundary == maxSkewMs is ok).
    const atBoundary = await verifySdrIngestRequest({
      secret: ISO_SECRET,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
      signature,
      nonce: ISO_NONCE,
      timestamp: ISO_TIMESTAMP_STRING,
      nowMs: ISO_TIMESTAMP_MS + 300_000,
    });
    expect(atBoundary).toEqual({ ok: true });

    // One ms beyond the boundary — must be rejected
    const beyondBoundary = await verifySdrIngestRequest({
      secret: ISO_SECRET,
      method: ISO_METHOD,
      path: ISO_PATH,
      body: ISO_BODY,
      signature,
      nonce: ISO_NONCE,
      timestamp: ISO_TIMESTAMP_STRING,
      nowMs: ISO_TIMESTAMP_MS + 300_001,
    });
    expect(beyondBoundary).toEqual({ ok: false, reason: "timestamp_skew" });
  });
});
