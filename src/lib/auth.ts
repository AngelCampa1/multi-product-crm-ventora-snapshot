/**
 * Cloudflare Access JWT verification middleware.
 *
 * In production every request to /api/admin/* arrives with a `Cf-Access-Jwt-Assertion`
 * header (set by Cloudflare Access after Google SSO). We verify it against the team's
 * public keys (JWKS) and check the `aud` claim matches the Access application's AUD tag.
 *
 * In local dev (`wrangler dev`), set DEV_AUTH_BYPASS=true in .dev.vars to short-circuit
 * verification and inject a stub email. The bypass is accepted only on local hosts,
 * so a production secret/config mistake fails closed.
 *
 * Reference: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

import type { Context, Next } from "hono";
import type { Env } from "../worker";

const ADMIN_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_HEADER = "X-Ventora-CSRF";

interface AccessClaims {
  email?: string;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
}

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  use?: string;
  n: string;
  e: string;
}

// JWKS cache lives in module scope. Workers isolate eviction will naturally bound it;
// no explicit TTL is needed for Phase 0. Phase 1 may add a 10-min refresh.
let cachedJwks: { keys: Jwk[]; fetchedAt: number } | null = null;

export async function requireAccess(c: Context<{ Bindings: Env }>, next: Next) {
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (c.env.DEV_AUTH_BYPASS === "true" && !token) {
    if (!isLocalDevRequest(
      c.req.url,
      c.req.header("Host"),
      c.req.header("CF-Ray"),
      c.env.DEV_AUTH_BYPASS_ALLOW_NONLOCAL_HOST === "true",
    )) {
      return c.json({ error: "DEV_AUTH_BYPASS is only allowed on local development hosts" }, 500);
    }
    c.set("accessEmail" as never, "dev@local");
    await next();
    return;
  }

  if (!token) {
    return c.json({ error: "missing CF Access JWT" }, 401);
  }

  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = c.env.CF_ACCESS_AUD;
  if (!teamDomain || !expectedAud) {
    return c.json({ error: "CF Access not configured on this Worker" }, 500);
  }

  let claims: AccessClaims;
  try {
    const localJwksUrl = c.env.DEV_AUTH_BYPASS === "true"
      ? c.env.CF_ACCESS_JWKS_URL
      : undefined;
    claims = await verifyAccessJwt(token, teamDomain, expectedAud, localJwksUrl);
  } catch (err) {
    return c.json({ error: "invalid CF Access JWT", detail: String(err) }, 401);
  }

  if (!claims.email) {
    return c.json({ error: "CF Access JWT missing email claim" }, 401);
  }

  c.set("accessEmail" as never, claims.email);
  await next();
}

export async function requireAdminMutationProtection(c: Context<{ Bindings: Env }>, next: Next) {
  if (!ADMIN_MUTATION_METHODS.has(c.req.method.toUpperCase())) {
    await next();
    return;
  }

  const validation = validateAdminMutationRequest({
    requestUrl: c.req.url,
    origin: c.req.header("Origin"),
    referer: c.req.header("Referer"),
    csrfHeader: c.req.header(CSRF_HEADER),
  });

  if (!validation.ok) {
    return c.json({ error: validation.error }, 403);
  }

  await next();
}

export function isLocalDevRequest(
  requestUrl: string,
  hostHeader?: string,
  cfRay?: string,
  allowNonlocalHttpWithoutCfRay = false,
): boolean {
  if (cfRay) return false;

  const url = new URL(requestUrl);
  const hostname = url.hostname.toLowerCase();
  if (isLocalHostname(hostname) || isLocalHostname((hostHeader ?? "").split(":")[0] ?? "")) {
    return true;
  }
  return allowNonlocalHttpWithoutCfRay && url.protocol === "http:" && !cfRay;
}

function isLocalHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

export function validateAdminMutationRequest(input: {
  requestUrl: string;
  origin?: string;
  referer?: string;
  csrfHeader?: string;
}): { ok: true } | { ok: false; error: string } {
  if (input.csrfHeader !== "1") {
    return { ok: false, error: "missing admin CSRF header" };
  }

  const expectedOrigin = new URL(input.requestUrl).origin;
  if (input.origin && input.origin !== expectedOrigin) {
    return { ok: false, error: "cross-origin admin mutation rejected" };
  }

  if (!input.origin && input.referer) {
    let refererOrigin: string;
    try {
      refererOrigin = new URL(input.referer).origin;
    } catch {
      return { ok: false, error: "invalid admin mutation referer" };
    }
    if (refererOrigin !== expectedOrigin) {
      return { ok: false, error: "cross-origin admin mutation rejected" };
    }
  }

  return { ok: true };
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string,
  jwksUrlOverride?: string,
): Promise<AccessClaims> {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("malformed JWT");

  const header = JSON.parse(b64urlDecode(headerB64)) as { kid: string; alg: string };
  if (header.alg !== "RS256") throw new Error(`unsupported alg ${header.alg}`);

  const jwk = await getJwk(teamDomain, header.kid, jwksUrlOverride);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToBytes(sigB64).buffer as ArrayBuffer;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
  if (!ok) throw new Error("signature mismatch");

  const claims = JSON.parse(b64urlDecode(payloadB64)) as AccessClaims;

  if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error("token expired");

  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.includes(expectedAud)) throw new Error("aud mismatch");

  const expectedIss = `https://${teamDomain}`;
  if (!claims.iss || claims.iss !== expectedIss) throw new Error("iss mismatch");

  return claims;
}

async function getJwk(teamDomain: string, kid: string, jwksUrlOverride?: string): Promise<Jwk> {
  const now = Date.now();
  // Refresh JWKS every 10 minutes. CF rotates keys infrequently; this is conservative.
  if (!cachedJwks || now - cachedJwks.fetchedAt > 10 * 60 * 1000) {
    const url = jwksUrlOverride ?? `https://${teamDomain}/cdn-cgi/access/certs`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys: Jwk[] };
    cachedJwks = { keys: body.keys, fetchedAt: now };
  }
  let jwk = cachedJwks.keys.find((k) => k.kid === kid);
  if (!jwk) {
    // kid not in cache — CF may have rotated keys; force one refresh before giving up
    const url = jwksUrlOverride ?? `https://${teamDomain}/cdn-cgi/access/certs`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = (await res.json()) as { keys: Jwk[] };
    cachedJwks = { keys: body.keys, fetchedAt: Date.now() };
    jwk = cachedJwks.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error(`no JWK matches kid ${kid}`);
  return jwk;
}

function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return atob(padded);
}

function b64urlToBytes(s: string): Uint8Array {
  const str = b64urlDecode(s);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}
