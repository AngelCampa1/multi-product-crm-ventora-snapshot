import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalDevRequest, validateAdminMutationRequest } from "../../src/lib/auth";
import worker, { type Env } from "../../src/worker";

function base64url(input: string | ArrayBuffer): string {
  const buffer = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signedAccessJwt(options: {
  kid: string;
  aud: string;
  iss: string;
  email?: string;
}): Promise<{ token: string; jwk: JsonWebKey & { kid: string; alg: string; use: string } }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;

  const header = base64url(JSON.stringify({ alg: "RS256", kid: options.kid }));
  const payload = base64url(JSON.stringify({
    aud: options.aud,
    iss: options.iss,
    email: options.email ?? "admin@example.test",
    exp: Math.floor(Date.now() / 1000) + 300,
  }));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return {
    token: `${header}.${payload}.${base64url(signature)}`,
    jwk: {
      ...jwk,
      kid: options.kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dev auth bypass guard", () => {
  it("allows bypass only on local development hosts", () => {
    expect(isLocalDevRequest("http://localhost:8787/api/admin/me")).toBe(true);
    expect(isLocalDevRequest("http://127.0.0.1:8787/api/admin/me")).toBe(true);
    expect(isLocalDevRequest("http://worker.internal/api/admin/me", "127.0.0.1:8787")).toBe(true);
    expect(isLocalDevRequest("http://worker.internal/api/admin/me", "127.0.0.1:8787", "abc")).toBe(false);
    expect(isLocalDevRequest("http://worker.internal/api/admin/me", "localhost:8787", "abc")).toBe(false);
    expect(isLocalDevRequest("http://worker.internal/api/admin/me")).toBe(false);
    expect(isLocalDevRequest("https://staging.ventoralabs.com/api/admin/me")).toBe(false);
    expect(isLocalDevRequest("https://crm.ventoralabs.com/api/admin/me", "crm.ventoralabs.com", "abc")).toBe(false);
    expect(isLocalDevRequest("http://crm.ventoralabs.com/api/admin/me", "crm.ventoralabs.com", "abc")).toBe(false);
    expect(isLocalDevRequest("https://widgets.ventoralabs.com/preview/camaudit-v2/wall-grid", "widgets.ventoralabs.com", "abc")).toBe(false);
  });

  it("allows Wrangler local custom-domain requests only with an explicit override", () => {
    expect(isLocalDevRequest(
      "http://crm.ventoralabs.com/api/admin/me",
      "crm.ventoralabs.com",
      undefined,
      true,
    )).toBe(true);
    expect(isLocalDevRequest(
      "http://crm.ventoralabs.com/api/admin/me",
      "crm.ventoralabs.com",
      "abc",
      true,
    )).toBe(false);
    expect(isLocalDevRequest(
      "https://crm.ventoralabs.com/api/admin/me",
      "crm.ventoralabs.com",
      undefined,
      true,
    )).toBe(false);
  });
});

describe("admin mutation CSRF guard", () => {
  it("requires the same-origin admin CSRF header", () => {
    expect(validateAdminMutationRequest({
      requestUrl: "https://crm.ventoralabs.com/api/admin/settings/products/camaudit-v2/regenerate-key",
      origin: "https://crm.ventoralabs.com",
    })).toEqual({ ok: false, error: "missing admin CSRF header" });
  });

  it("rejects cross-origin admin mutations even with the header", () => {
    expect(validateAdminMutationRequest({
      requestUrl: "https://crm.ventoralabs.com/api/admin/settings/products/camaudit-v2/regenerate-key",
      origin: "https://attacker.example",
      csrfHeader: "1",
    })).toEqual({ ok: false, error: "cross-origin admin mutation rejected" });
  });

  it("allows same-origin admin mutations with the header", () => {
    expect(validateAdminMutationRequest({
      requestUrl: "https://crm.ventoralabs.com/api/admin/settings/products/camaudit-v2/regenerate-key",
      origin: "https://crm.ventoralabs.com",
      csrfHeader: "1",
    })).toEqual({ ok: true });
  });
});

describe("mounted Worker CF Access auth", () => {
  it("accepts a valid Access JWT through the mounted admin route", async () => {
    const teamDomain = "team.example.cloudflareaccess.com";
    const aud = "access-aud";
    const { token, jwk } = await signedAccessJwt({
      kid: "kid-valid-access",
      aud,
      iss: `https://${teamDomain}`,
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe(`https://${teamDomain}/cdn-cgi/access/certs`);
      return Response.json({ keys: [jwk] });
    }));

    const response = await worker.fetch(
      new Request("https://crm.ventoralabs.com/api/admin/me", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      {
        CF_ACCESS_TEAM_DOMAIN: teamDomain,
        CF_ACCESS_AUD: aud,
      } as Env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: "admin@example.test" });
  });

  it("rejects missing Access JWTs through the mounted admin route", async () => {
    const response = await worker.fetch(
      new Request("https://crm.ventoralabs.com/api/admin/me"),
      {
        CF_ACCESS_TEAM_DOMAIN: "team.example.cloudflareaccess.com",
        CF_ACCESS_AUD: "access-aud",
      } as Env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "missing CF Access JWT" });
  });

  it("ignores local JWKS overrides on non-local requests", async () => {
    const teamDomain = "team.example.cloudflareaccess.com";
    const aud = "access-aud";
    const { token } = await signedAccessJwt({
      kid: "kid-nonlocal-override",
      aud,
      iss: `https://${teamDomain}`,
    });
    const fetchMock = vi.fn(async () => Response.json({ keys: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://crm.ventoralabs.com/api/admin/me", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      {
        CF_ACCESS_TEAM_DOMAIN: teamDomain,
        CF_ACCESS_AUD: aud,
        CF_ACCESS_JWKS_URL: "http://127.0.0.1:18989/certs",
        DEV_AUTH_BYPASS: "false",
      } as Env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalledWith("http://127.0.0.1:18989/certs");
    expect(fetchMock).toHaveBeenCalledWith(`https://${teamDomain}/cdn-cgi/access/certs`);
  });
});
