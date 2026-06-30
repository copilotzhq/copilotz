/**
 * ChatGPT OAuth end-to-end probe.
 *
 * Reproduces the Compass transport exactly:
 * - Codex CLI OAuth client with PKCE
 * - ChatGPT OAuth bearer token
 * - ChatGPT-Account-ID header
 * - https://chatgpt.com/backend-api/codex/responses
 * - a real Copilotz agent backed by an in-memory database
 *
 * Tokens are kept in memory and are never printed or persisted.
 *
 * Run:
 *   deno run -A examples/chatgpt-oauth-e2e.ts
 *
 * By default, the probe reuses an existing Codex CLI ChatGPT login without
 * modifying it. Use --fresh-login only for a clean-room OAuth test.
 *
 * Optional:
 *   CHATGPT_OAUTH_E2E_MODEL=gpt-5.4 \
 *     deno run -A examples/chatgpt-oauth-e2e.ts
 */

import { createCopilotz } from "../index.ts";

const AUTH_BASE = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
];
const MODEL = Deno.env.get("CHATGPT_OAUTH_E2E_MODEL") ?? "gpt-5.4";

type OAuthCallback = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type JwtClaims = {
  exp?: number;
  chatgpt_account_id?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
};

type CodexAuthFile = {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    account_id?: string;
    id_token?: string;
  };
};

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomToken(length = 48): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(length)));
}

function decodeJwtClaims(token: string | undefined): JwtClaims {
  if (!token) return {};
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(atob(padded)) as JwtClaims;
  } catch {
    return {};
  }
}

function accountIdFromTokens(tokens: TokenResponse): string | null {
  for (
    const claims of [
      decodeJwtClaims(tokens.access_token),
      decodeJwtClaims(tokens.id_token),
    ]
  ) {
    const accountId = claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId.length > 0) {
      return accountId;
    }
  }
  return null;
}

async function loadCodexLogin(): Promise<
  {
    accessToken: string;
    accountId: string;
  } | null
> {
  const codexHome = Deno.env.get("CODEX_HOME") ??
    (Deno.env.get("HOME") ? `${Deno.env.get("HOME")}/.codex` : null);
  if (!codexHome) return null;

  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(
      await Deno.readTextFile(`${codexHome}/auth.json`),
    ) as CodexAuthFile;
  } catch {
    return null;
  }

  const accessToken = auth.tokens?.access_token;
  if (auth.auth_mode !== "chatgpt" || !accessToken) return null;

  const claims = decodeJwtClaims(accessToken);
  if (
    typeof claims.exp === "number" &&
    claims.exp * 1000 <= Date.now() + 60_000
  ) {
    throw new Error(
      'The local Codex access token is expired. Run "codex login" and retry.',
    );
  }

  const accountId = auth.tokens?.account_id ??
    accountIdFromTokens({
      access_token: accessToken,
      id_token: auth.tokens?.id_token,
    });
  if (!accountId) {
    throw new Error("The local Codex login has no ChatGPT account id.");
  }

  console.log(
    "Using the existing local Codex ChatGPT login; no token was copied or modified.",
  );
  return { accessToken, accountId };
}

function callbackFromInput(input: string): OAuthCallback {
  try {
    const url = new URL(input);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
      errorDescription: url.searchParams.get("error_description") ?? undefined,
    };
  } catch {
    return { code: input.trim() || undefined };
  }
}

async function authenticate(): Promise<{
  accessToken: string;
  accountId: string;
}> {
  const verifier = randomToken();
  const challenge = await sha256Base64Url(verifier);
  const state = randomToken(32);
  const authorizeUrl = new URL(`${AUTH_BASE}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPES.join(" "));
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("id_token_add_organizations", "true");
  authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authorizeUrl.searchParams.set("originator", "codex_cli");
  authorizeUrl.searchParams.set("state", state);

  let callback: OAuthCallback = {};
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 1455,
    onListen: () => {},
  }, (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/auth/callback") {
      return new Response("Not found", { status: 404 });
    }
    callback = {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
      errorDescription: url.searchParams.get("error_description") ?? undefined,
    };
    return new Response(
      "<h1>Authentication received</h1><p>You can return to the terminal.</p>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  });

  console.log("\nOpen this URL in your browser and sign in with ChatGPT:\n");
  console.log(authorizeUrl.toString());
  console.log("\nWaiting up to two minutes for the localhost callback...");

  const deadline = Date.now() + 300_000;
  while (!callback.code && !callback.error && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!callback.code && !callback.error) {
    const pasted = prompt(
      "Callback not received. Paste the full redirect URL (or code):",
    );
    callback = callbackFromInput(pasted ?? "");
    callback.state ??= state;
  }

  await server.shutdown();

  if (callback.error) {
    throw new Error(
      `OAuth authorization failed: ${
        callback.errorDescription ?? callback.error
      }`,
    );
  }
  if (!callback.code) {
    throw new Error("OAuth authorization did not return a code.");
  }
  if (callback.state !== state) {
    throw new Error("OAuth state mismatch.");
  }

  const response = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const tokens = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok || tokens.error || !tokens.access_token) {
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${
        tokens.error_description ?? tokens.error ?? "unknown error"
      }`,
    );
  }

  const accountId = accountIdFromTokens(tokens);
  if (!accountId) {
    throw new Error(
      "OAuth tokens did not contain a ChatGPT account id.",
    );
  }

  console.log("OAuth succeeded; token and account id are held in memory.");
  return { accessToken: tokens.access_token, accountId };
}

async function runAgent(
  credentials: { accessToken: string; accountId: string },
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const response = await originalFetch(input, init);
    if (url.startsWith(CODEX_BASE_URL) && !response.ok) {
      const body = await response.clone().text().catch(() => "");
      console.error(
        `Codex endpoint error (${response.status}): ${body.slice(0, 4_000)}`,
      );
    }
    return response;
  };

  const copilotz = await createCopilotz({
    namespace: `chatgpt-oauth-e2e-${crypto.randomUUID()}`,
    agentsFile: false,
    agents: [{
      id: "oauth-probe",
      name: "OAuth Probe",
      role: "transport verifier",
      instructions:
        'Reply with exactly "PONG". Do not include punctuation or explanation.',
      allowedTools: null,
      llmOptions: {
        provider: "openai",
        model: MODEL,
        openaiApi: "responses",
        maxTokens: 32,
        reasoningEffort: "low",
        estimateCost: false,
      },
    }],
    security: {
      resolveLLMRuntimeConfig: ({ provider }) =>
        provider === "openai"
          ? {
            apiKey: credentials.accessToken,
            baseUrl: CODEX_BASE_URL,
            extraHeaders: {
              "ChatGPT-Account-ID": credentials.accountId,
            },
          }
          : undefined,
    },
    dbConfig: { url: ":memory:" },
  });

  try {
    console.log(`\nRunning Copilotz agent with ${MODEL}...`);
    const result = await copilotz.run({
      content: 'Reply with exactly "PONG".',
      sender: { type: "user", id: "oauth-probe-user", name: "Probe User" },
      target: "oauth-probe",
    }, { stream: true });

    const visible: string[] = [];
    let failure: string | null = null;
    for await (const event of result.events) {
      if (event.type === "TOKEN") {
        const payload = event.payload as {
          token?: string;
          isReasoning?: boolean;
        };
        if (payload.token && !payload.isReasoning) {
          visible.push(payload.token);
        }
      }
      if (event.type === "LLM_RESULT") {
        const payload = event.payload as {
          status?: string;
          answer?: string | null;
          error?: { message?: string | null } | null;
        };
        if (payload.status === "failed") {
          failure = payload.error?.message ?? payload.answer ??
            "Unknown LLM failure";
        }
      }
    }
    await result.done;

    if (failure) throw new Error(failure);
    const answer = visible.join("").trim();
    console.log(`Agent response: ${JSON.stringify(answer)}`);
    if (answer !== "PONG") {
      throw new Error(`Expected "PONG", received ${JSON.stringify(answer)}.`);
    }
    console.log("\nPASS: ChatGPT OAuth worked through a real Copilotz agent.");
  } finally {
    await copilotz.shutdown();
    globalThis.fetch = originalFetch;
  }
}

const credentials = Deno.args.includes("--fresh-login")
  ? await authenticate()
  : await loadCodexLogin() ?? await authenticate();
await runAgent(credentials);
