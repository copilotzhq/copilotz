/**
 * Google auth without SDKs (`cloud/shared/google.ts`), and the Compute Engine
 * host's `verify`: access tokens from a fake metadata server, from ADC files
 * (a person's refresh token, a service account's key) against a fake token
 * endpoint, traded for a service account's (a fake IAM Credentials); and
 * pool VMs' identity tokens, signed with a key made here and checked against
 * a fake certs URL. No call reaches Google.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gceHost } from "../cloud/adapters/gce/index.ts";
import { googleToken, signJwt, verifyIdentityToken } from "../cloud/shared/google.ts";
import { serve, tempDir, test } from "../../../testing/mod.ts";

const ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

/** An RSA key, as PEM (PKCS #8, as a key file has it) and as a public JWK (as Google's certs). */
async function keyPair(kid: string) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")
  }\n-----END PRIVATE KEY-----\n`;
  const jwk = { ...await crypto.subtle.exportKey("jwk", publicKey), kid, alg: "RS256", use: "sig" };
  return { pem, jwk, publicKey };
}

const form = async (request: Request) =>
  Object.fromEntries(new URLSearchParams(await request.text()));
const decode = (part: string) =>
  JSON.parse(
    atob(part.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((part.length + 3) % 4)),
  );

test("on Cloud Run and Compute Engine, the token is the metadata server's, kept until it's nearly expired", async () => {
  const asked: Request[] = [];
  let expiresIn = 3599;
  const metadata = await serve((request) => {
    asked.push(request);
    return Response.json({
      access_token: `meta-${asked.length}`,
      expires_in: expiresIn,
      token_type: "Bearer",
    });
  });
  try {
    const token = googleToken({ metadata: metadata.url, metadataOnly: true });
    assertEquals(await Promise.all([token(), token()]), ["meta-1", "meta-1"]);
    assertEquals(await token(), "meta-1");
    assertEquals(asked.length, 1);
    assertEquals(new URL(asked[0].url).pathname, "/instance/service-accounts/default/token");
    assertEquals(asked[0].headers.get("metadata-flavor"), "Google");

    // A token about to expire is renewed.
    expiresIn = 30;
    const short = googleToken({ metadata: metadata.url, metadataOnly: true });
    assertEquals(await short(), "meta-2");
    assertEquals(await short(), "meta-3");
  } finally {
    await metadata.close();
  }
});

test("locally, a person's ADC refresh token gets the token; impersonation trades it for the controller's", async () => {
  const file = join(tempDir(), "adc.json");
  writeFileSync(
    file,
    JSON.stringify({
      type: "authorized_user",
      client_id: "client.apps.googleusercontent.com",
      client_secret: "shh",
      refresh_token: "1//refresh",
    }),
  );
  const asked: { path: string; auth?: string | null; body: unknown }[] = [];
  const google = await serve(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/token") {
      asked.push({ path, body: await form(request) });
      return Response.json({ access_token: "ya29.person", expires_in: 3599 });
    }
    asked.push({ path, auth: request.headers.get("authorization"), body: await request.json() });
    return Response.json({
      accessToken: "ya29.controller",
      expireTime: new Date(Date.now() + 3600_000).toISOString(),
    });
  });
  try {
    const own = googleToken({ credentials: file, tokenUrl: `${google.url}/token` });
    assertEquals(await own(), "ya29.person");
    assertEquals(asked[0].body, {
      grant_type: "refresh_token",
      client_id: "client.apps.googleusercontent.com",
      client_secret: "shh",
      refresh_token: "1//refresh",
    });

    const controller = "cz-controller@copilotz-485719.iam.gserviceaccount.com";
    const acting = googleToken({
      credentials: file,
      tokenUrl: `${google.url}/token`,
      iam: `${google.url}/v1`,
      impersonate: controller,
    });
    assertEquals(await acting(), "ya29.controller");
    assertEquals(await acting(), "ya29.controller");
    const trade = asked.at(-1)!;
    assertEquals(
      trade.path,
      `/v1/projects/-/serviceAccounts/${encodeURIComponent(controller)}:generateAccessToken`,
    );
    assertEquals(trade.auth, "Bearer ya29.person");
    assertEquals(trade.body, {
      scope: ["https://www.googleapis.com/auth/cloud-platform"],
      lifetime: "3600s",
    });
    assertEquals(asked.length, 3);

    // A file named that isn't there is an error, not the metadata server.
    await assertRejects(
      () => googleToken({ credentials: join(tempDir(), "none.json") })(),
      Error,
      "can't read",
    );
  } finally {
    await google.close();
  }
});

test("a service account's key signs a JWT, traded for its token", async () => {
  const { pem, publicKey } = await keyPair("key-1");
  const file = join(tempDir(), "sa.json");
  const google = await serve(async (request) => {
    const { grant_type, assertion } = await form(request);
    assertEquals(grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [head, body, signature] = assertion.split(".");
    const signed = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Uint8Array.from(
        atob(
          signature.replaceAll("-", "+").replaceAll("_", "/") +
            "===".slice((signature.length + 3) % 4),
        ),
        (c) => c.charCodeAt(0),
      ),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!signed) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({
      access_token: `sa:${decode(body).iss}:${decode(head).kid}`,
      expires_in: 3599,
    });
  });
  try {
    writeFileSync(
      file,
      JSON.stringify({
        type: "service_account",
        client_email: "cz-controller@copilotz-485719.iam.gserviceaccount.com",
        private_key_id: "key-1",
        private_key: pem,
        token_uri: `${google.url}/token`,
      }),
    );
    const token = googleToken({ credentials: file });
    assertEquals(await token(), "sa:cz-controller@copilotz-485719.iam.gserviceaccount.com:key-1");
  } finally {
    await google.close();
  }
});

/** Google's certs, served here, with a key to sign identity tokens with as Google would. */
async function fakeGoogle() {
  const google = await keyPair("google-1");
  let fetched = 0;
  const server = await serve(() => {
    fetched++;
    return Response.json({ keys: [google.jwk] }, {
      headers: { "cache-control": "public, max-age=19800, must-revalidate, no-transform" },
    });
  });
  const now = Math.floor(Date.now() / 1000);
  const identity = (claims: Record<string, unknown> = {}, pem = google.pem, vm = {}) =>
    signJwt({ alg: "RS256", kid: "google-1", typ: "JWT" }, {
      iss: "https://accounts.google.com",
      aud: "https://compass.copilotz.com",
      azp: "1234567890",
      sub: "1234567890",
      iat: now,
      exp: now + 3600,
      google: {
        compute_engine: {
          project_id: "copilotz-485719",
          project_number: 1234567890,
          zone: "us-central1-a",
          instance_id: "4471234567890",
          instance_name: "cz-pool-small-x7k2",
          instance_creation_timestamp: now - 60,
          ...vm,
        },
      },
      ...claims,
    }, pem);
  return { certs: server.url, identity, fetched: () => fetched, close: server.close };
}

const APP = "https://compass.copilotz.com";

test("an identity token is checked: Google's signature, issuer, audience, times, a VM named", async () => {
  const google = await fakeGoogle();
  try {
    const check = (jwt: string) => verifyIdentityToken(jwt, APP, { certs: google.certs });
    const vm = await check(await google.identity());
    assertEquals(vm.project_id, "copilotz-485719");
    assertEquals(vm.zone, "us-central1-a");
    assertEquals(vm.instance_name, "cz-pool-small-x7k2");
    assertEquals(vm.instance_id, "4471234567890");
    // Without the scheme, too.
    await check(await google.identity({ iss: "accounts.google.com" }));
    // Google's keys were fetched once: its Cache-Control keeps them.
    assertEquals(google.fetched(), 1);

    await assertRejects(
      async () => await check(await google.identity({ aud: "https://elsewhere.example" })),
      Error,
      "another audience",
    );
    const hourAgo = Math.floor(Date.now() / 1000) - 3600;
    await assertRejects(
      async () => await check(await google.identity({ iat: hourAgo - 3600, exp: hourAgo })),
      Error,
      "expired",
    );
    await assertRejects(
      async () => await check(await google.identity({ iat: hourAgo + 7200 + 600 })),
      Error,
      "issued later",
    );
    await assertRejects(
      async () => await check(await google.identity({ iss: "https://evil.example" })),
      Error,
      "not issued by Google",
    );
    const other = await keyPair("google-1");
    await assertRejects(
      async () => await check(await google.identity({}, other.pem)),
      Error,
      "bad signature",
    );
    await assertRejects(
      async () => await check(await google.identity({ google: undefined })),
      Error,
      "names no VM",
    );
  } finally {
    await google.close();
  }
});

test("verify takes pool VMs of the app's placements only", async () => {
  const google = await fakeGoogle();
  try {
    const here = { project: "copilotz-485719", zone: "us-central1-a" };
    const host = gceHost({
      token: () => Promise.reject(new Error("verify needs no token")),
      api: "http://127.0.0.1:1/never",
      certs: google.certs,
      placements: [{ project: "other-project", zone: "us-east1-b" }, here],
    });
    const jwt = await google.identity();
    assertEquals(await host.verify(`pool:gce:${jwt}`, APP), {
      vm: "cz-pool-small-x7k2",
      placement: here,
    });
    assertEquals(await host.verify(`gce:${jwt}`, APP), {
      vm: "cz-pool-small-x7k2",
      placement: here,
    });

    // Another audience, expired, another project or zone, not a pool VM, not a GCE credential.
    assertEquals(await host.verify(`pool:gce:${jwt}`, "https://elsewhere.example"), null);
    const past = Math.floor(Date.now() / 1000) - 7200;
    assertEquals(
      await host.verify(`pool:gce:${await google.identity({ iat: past, exp: past + 600 })}`, APP),
      null,
    );
    assertEquals(
      await host.verify(
        `pool:gce:${await google.identity({}, undefined, { project_id: "someone-else" })}`,
        APP,
      ),
      null,
    );
    assertEquals(
      await host.verify(
        `pool:gce:${await google.identity({}, undefined, { zone: "us-central1-b" })}`,
        APP,
      ),
      null,
    );
    assertEquals(
      await host.verify(
        `pool:gce:${await google.identity({}, undefined, { instance_name: "dev-box" })}`,
        APP,
      ),
      null,
    );
    assertEquals(await host.verify(`pool:docker:${jwt}`, APP), null);
    assertEquals(await host.verify("pool:gce:not.a.jwt", APP), null);

    // Placements read when asked; none, no pool VM passes.
    let known: typeof here[] = [];
    const later = gceHost({
      token: () => Promise.resolve("x"),
      certs: google.certs,
      placements: () => known,
    });
    assertEquals(await later.verify(`pool:gce:${jwt}`, APP), null);
    known = [here];
    assert(await later.verify(`pool:gce:${jwt}`, APP));
  } finally {
    await google.close();
  }
});
