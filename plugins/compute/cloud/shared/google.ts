/**
 * Google auth without Google's SDKs, with fetch and WebCrypto alone.
 *
 * - `googleToken`: an access token for Google's APIs, kept until shortly
 *   before it expires. On Cloud Run and Compute Engine it's the metadata
 *   server's; locally, Application Default Credentials'
 *   (`GOOGLE_APPLICATION_CREDENTIALS`, else gcloud's
 *   `application_default_credentials.json`): a person's refresh token, or a
 *   service account's key. Given `impersonate`, it trades that token for
 *   one of the service account named (IAM Credentials' `generateAccessToken`).
 * - `verifyIdentityToken`: who a Compute Engine VM is, from an identity
 *   token it got from its metadata server (`format=full`): signed by Google,
 *   for this audience, current. It answers the VM's project, zone and name.
 *
 * Every endpoint can be replaced, so tests run against local fakes.
 */

/** The metadata server, on Cloud Run and Compute Engine. */
export const METADATA = "http://metadata.google.internal/computeMetadata/v1";
/** Where refresh tokens and service accounts' JWTs are traded for access tokens. */
export const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
/** IAM Credentials: tokens of a service account one may act as. */
export const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com/v1";
/** Google's keys, that its ID tokens are signed with. */
export const CERTS = "https://www.googleapis.com/oauth2/v3/certs";
/** The scope of a token for any Google Cloud API (its IAM roles say what it may do). */
export const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

/** Where `googleToken` gets its tokens from, and how. All optional. */
export type GoogleAuthOptions = {
  /** A service account to act as (`cz-controller@<project>.iam.gserviceaccount.com`). */
  impersonate?: string;
  /** The ADC file; default `GOOGLE_APPLICATION_CREDENTIALS`, else gcloud's. */
  credentials?: string;
  /** Whether to use the metadata server even when an ADC file is there. */
  metadataOnly?: boolean;
  /** The token's scope; default `cloud-platform`. */
  scope?: string;
  /** Endpoints, for tests: the metadata server, the OAuth token endpoint, IAM Credentials. */
  metadata?: string;
  tokenUrl?: string;
  iam?: string;
  fetch?: typeof fetch;
};

type Kept = { token: string; until: number };

/** A token is renewed this long before it expires. */
const MARGIN = 60_000;

/**
 * An access token for Google's APIs, as a function: each call answers the
 * kept one while it has more than a minute left, else gets another
 * (one request at a time, however many callers wait for it).
 */
export function googleToken(options: GoogleAuthOptions = {}): () => Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const scope = options.scope ?? CLOUD_PLATFORM;
  let kept: Kept | undefined;
  let pending: Promise<Kept> | undefined;

  // The token of whoever runs this: the metadata server's account, or the ADC's.
  const own = async (): Promise<Kept> => {
    const file = options.metadataOnly ? undefined : await adcFile(options.credentials);
    if (!file) return await metadataToken(options.metadata ?? METADATA, fetcher);
    const tokenUrl = options.tokenUrl ?? (file.token_uri as string | undefined) ?? OAUTH_TOKEN;
    if (file.type === "authorized_user") return await refreshToken(file, tokenUrl, fetcher);
    if (file.type === "service_account") {
      return await serviceAccountToken(file, tokenUrl, scope, fetcher);
    }
    throw new Error(`Google credentials: ${file.type ?? "this kind"} isn't supported`);
  };

  const fresh = async (): Promise<Kept> => {
    const source = await own();
    if (!options.impersonate) return source;
    return await impersonated(
      options.impersonate,
      source.token,
      scope,
      options.iam ?? IAM_CREDENTIALS,
      fetcher,
    );
  };

  return async () => {
    if (kept && kept.until - MARGIN > Date.now()) return kept.token;
    pending ??= fresh().finally(() => pending = undefined);
    kept = await pending;
    return kept.token;
  };
}

/** The ADC file, if there's one (its JSON), else undefined: then it's the metadata server. */
async function adcFile(path?: string): Promise<Record<string, unknown> | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { env } = await import("node:process");
  const given = path ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  const file = given ??
    (env.APPDATA
      ? `${env.APPDATA}/gcloud/application_default_credentials.json`
      : `${
        env.CLOUDSDK_CONFIG ?? `${homedir()}/.config/gcloud`
      }/application_default_credentials.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    // gcloud's own file is optional; one named explicitly isn't.
    if (given) throw new Error(`Google credentials: can't read ${given}: ${error}`);
    return undefined;
  }
}

async function metadataToken(base: string, fetcher: typeof fetch): Promise<Kept> {
  const response = await fetcher(`${base}/instance/service-accounts/default/token`, {
    headers: { "Metadata-Flavor": "Google" },
  }).catch((error) => {
    throw new Error(
      `Google credentials: no ADC file, and no metadata server (${error}): off Google Cloud, run \`gcloud auth application-default login\` or set GOOGLE_APPLICATION_CREDENTIALS`,
    );
  });
  const body = await answer(response, "the metadata server's token");
  return expiring(body.access_token, body.expires_in);
}

/** A person's credentials (`gcloud auth application-default login`): a refresh token. */
async function refreshToken(
  file: Record<string, unknown>,
  tokenUrl: string,
  fetcher: typeof fetch,
): Promise<Kept> {
  const response = await fetcher(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: String(file.client_id),
      client_secret: String(file.client_secret),
      refresh_token: String(file.refresh_token),
    }),
  });
  const body = await answer(response, "refreshing the ADC's token");
  return expiring(body.access_token, body.expires_in);
}

/** A service account's key: a JWT it signs, traded for a token (RFC 7523). */
async function serviceAccountToken(
  file: Record<string, unknown>,
  tokenUrl: string,
  scope: string,
  fetcher: typeof fetch,
): Promise<Kept> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT", kid: file.private_key_id as string | undefined },
    { iss: file.client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 },
    String(file.private_key),
  );
  const response = await fetcher(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await answer(response, "the service account's token");
  return expiring(body.access_token, body.expires_in);
}

/** A token for `account`, made with the caller's (who needs Token Creator on it). */
async function impersonated(
  account: string,
  token: string,
  scope: string,
  iam: string,
  fetcher: typeof fetch,
): Promise<Kept> {
  const url = `${iam}/projects/-/serviceAccounts/${
    encodeURIComponent(account)
  }:generateAccessToken`;
  const response = await fetcher(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ scope: [scope], lifetime: "3600s" }),
  });
  const body = await answer(response, `acting as ${account}`);
  return { token: body.accessToken, until: Date.parse(body.expireTime) };
}

const expiring = (token: string, expiresIn: number): Kept => ({
  token,
  until: Date.now() + (Number(expiresIn) || 3600) * 1000,
});

// deno-lint-ignore no-explicit-any
async function answer(response: Response, what: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google auth, ${what}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// JWTs: base64url, signing (a service account's key) and checking (Google's keys).

const encoder = new TextEncoder();
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
const unbase64url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4)),
    (c) => c.charCodeAt(0),
  );
const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

/** A JWT signed with RS256 by a PKCS #8 key in PEM (as a service account's key file has it). */
export async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  pem: string,
): Promise<string> {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("pkcs8", der, ALGORITHM, false, ["sign"]);
  const signed = `${part(header)}.${part(claims)}`;
  const signature = await crypto.subtle.sign(ALGORITHM.name, key, encoder.encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

/** What a Compute Engine identity token (`format=full`) says about its VM. */
export type ComputeEngine = {
  project_id: string;
  project_number?: number;
  zone: string;
  instance_id: string;
  instance_name: string;
  instance_creation_timestamp?: number;
};

/** How `verifyIdentityToken` checks a token. All optional. */
export type VerifyOptions = {
  /** Google's keys (a JWKS URL); default theirs. */
  certs?: string;
  fetch?: typeof fetch;
  /** Now, in ms; default the clock. */
  now?: number;
  /** How far apart clocks may be, in seconds; default 60. */
  skew?: number;
};

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

type Jwk = JsonWebKey & { kid?: string };
const certs = new Map<string, { keys: Jwk[]; until: number }>();

/** Google's keys, kept as long as its Cache-Control says (or again, for a key it hasn't seen). */
async function keysFor(url: string, fetcher: typeof fetch, again = false): Promise<Jwk[]> {
  const known = certs.get(url);
  if (known && !again && known.until > Date.now()) return known.keys;
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Google's keys: HTTP ${response.status}`);
  const age = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
  const { keys } = await response.json() as { keys: Jwk[] };
  certs.set(url, { keys, until: Date.now() + (Number.isFinite(age) ? age * 1000 : 3_600_000) });
  return keys;
}

/**
 * Checks a Compute Engine VM's identity token: RS256 by one of Google's
 * keys, issued by Google for `audience`, current (within `skew`), and
 * `format=full` (it names its VM). Answers the VM's claims, or throws why not.
 */
export async function verifyIdentityToken(
  jwt: string,
  audience: string,
  options: VerifyOptions = {},
): Promise<ComputeEngine> {
  const fetcher = options.fetch ?? fetch;
  const url = options.certs ?? CERTS;
  const now = (options.now ?? Date.now()) / 1000;
  const skew = options.skew ?? 60;
  const [head, body, signature] = jwt.split(".");
  if (!head || !body || !signature) throw refused("not a JWT");
  const header = JSON.parse(new TextDecoder().decode(unbase64url(head)));
  if (header.alg !== "RS256") throw refused("not signed with RS256");
  let jwk = (await keysFor(url, fetcher)).find((k) => k.kid === header.kid);
  // Google rotates its keys: one it hasn't seen may be new.
  jwk ??= (await keysFor(url, fetcher, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw refused("signed with an unknown key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    ALGORITHM,
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    ALGORITHM.name,
    key,
    unbase64url(signature),
    encoder.encode(`${head}.${body}`),
  );
  if (!ok) throw refused("a bad signature");
  const claims = JSON.parse(new TextDecoder().decode(unbase64url(body)));
  if (!ISSUERS.includes(claims.iss)) throw refused("not issued by Google");
  if (claims.aud !== audience) throw refused("issued for another audience");
  if (typeof claims.exp !== "number" || claims.exp + skew <= now) throw refused("expired");
  if (typeof claims.iat !== "number" || claims.iat - skew > now) throw refused("issued later");
  const vm = claims.google?.compute_engine as ComputeEngine | undefined;
  if (!vm?.project_id || !vm.zone || !vm.instance_name) {
    throw refused("it names no VM (format=full)");
  }
  return vm;
}

const refused = (why: string) =>
  Object.assign(new Error(`Identity token refused: ${why}`), { code: "forbidden" });
