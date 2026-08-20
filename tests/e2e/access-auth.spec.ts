import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

const JWKS_PORT = 18989;
const TEAM_DOMAIN = "e2e-access.test";
const ACCESS_AUD = "e2e-aud";

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

async function startJwksServer(jwk: JsonWebKey): Promise<{ close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url !== "/certs") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });

  await new Promise<void>((resolve) => server.listen(JWKS_PORT, "127.0.0.1", resolve));
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

test("verifies a CF Access JWT through the Wrangler Worker runtime", async ({ request }) => {
  const { token, jwk } = await signedAccessJwt({
    kid: `e2e-access-${Date.now()}`,
    aud: ACCESS_AUD,
    iss: `https://${TEAM_DOMAIN}`,
  });
  const jwks = await startJwksServer(jwk);

  try {
    const response = await request.get("/api/admin/me", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });

    await expect(response).toBeOK();
    await expect(response.json()).resolves.toEqual({ email: "admin@example.test" });
  } finally {
    await jwks.close();
  }
});
