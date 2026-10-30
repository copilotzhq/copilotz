/**
 * OAuth 2.0 with PKCE, as accounts use it (web standards only): the sign-in
 * address, the token endpoint's answers (a code's, a refresh's), revoking,
 * and what a token says about itself. Failures say what happened by code
 * and status only: a provider's answer, which may echo what was sent, is
 * never put in an error.
 */
import type { AccountProvider, TokenAnswer } from "../contract.ts";
import { refused, unavailable } from "./errors.ts";

const encoder = new TextEncoder();

export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const fromBase64url = (text: string) =>
  Uint8Array.from(
    atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4)),
    (c) => c.charCodeAt(0),
  );

/** A new secret: `bytes` random bytes, base64url. */
export const random = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** SHA-256, hex: how a sign-in's state is kept (never the state itself). */
export async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PKCE's S256 challenge for a verifier. */
export const challenge = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));

/** Where the person signs in: the authorization code flow, with PKCE and a state. */
export function signIn(
  provider: AccountProvider,
  sign: { state: string; challenge: string; redirect: string },
): string {
  const { oauth } = provider;
  const url = new URL(oauth.authorize);
  const params = {
    response_type: "code",
    client_id: oauth.clientId,
    redirect_uri: sign.redirect,
    ...(oauth.scopes?.length ? { scope: oauth.scopes.join(" ") } : {}),
    code_challenge: sign.challenge,
    code_challenge_method: "S256",
    ...oauth.params,
    state: sign.state,
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

/** How long to wait for a token endpoint, and for a revocation (which never holds anything up). */
const TOKEN_MS = 30_000;
const REVOKE_MS = 5_000;

/** An OAuth error code as it may be said: a short word (`invalid_grant`), nothing else. */
export const codeWord = (code: unknown) =>
  typeof code === "string" && /^[\w.-]{1,60}$/.test(code) ? code : undefined;

/** The OAuth error a provider answered with: `{ error: "invalid_grant" }`, or `{ error: { code } }`. */
function errorOf(body: Record<string, unknown>): string | undefined {
  const error = body.error as unknown;
  if (typeof error === "string") return codeWord(error) ?? "error";
  if (error && typeof error === "object") {
    return codeWord((error as { code?: unknown }).code) ?? "error";
  }
  return codeWord(body.code);
}

/**
 * Asks the token endpoint for tokens (a code's, a refresh token's). Fails
 * `account_unavailable` when it can't be reached or is busy, and
 * `account_refused` (with its OAuth `error`) when it says no.
 */
export async function tokens(
  provider: AccountProvider,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenAnswer> {
  const { oauth, title } = provider;
  let response: Response;
  try {
    response = await fetch(oauth.token, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
        ...params,
      }),
      // A token endpoint that redirects is not one to send a code to.
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_MS)])
        : AbortSignal.timeout(TOKEN_MS),
    });
  } catch {
    throw unavailable(`${title} can't be reached right now: try again in a moment`);
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.status >= 500 || response.status === 429) {
    throw unavailable(`${title} is busy (${response.status}): try again in a moment`);
  }
  const error = errorOf(body);
  if (!response.ok || error || typeof body.access_token !== "string" || !body.access_token) {
    throw Object.assign(refused(`${title} refused it (${error ?? response.status})`), {
      oauth: error ?? `http_${response.status}`,
    });
  }
  return body as TokenAnswer;
}

/** Tells the provider to end a token (RFC 7009), as far as it will in a few seconds. */
export async function revoke(provider: AccountProvider, token: string, hint: string) {
  const { oauth } = provider;
  if (!oauth.revoke) return;
  await fetch(oauth.revoke, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: oauth.clientId,
      ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(REVOKE_MS),
  }).then((response) => response.body?.cancel(), () => {});
}

/**
 * What a JWT says (its claims), unchecked: for a token the token endpoint
 * itself just answered, over TLS, which is what vouches for it.
 */
export function claimsOf(token: unknown): Record<string, unknown> | undefined {
  const part = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!part) return undefined;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
    return claims && typeof claims === "object" ? claims : undefined;
  } catch {
    return undefined;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A token this close to running out is renewed before it's used. */
export const SKEW = MINUTE;

/**
 * When an answer's access token runs out: as it says (`expires_in`), else as
 * the token says of itself (a JWT's `exp`), else in an hour.
 */
export function expiresOf(answer: TokenAnswer, now: number): number {
  if (typeof answer.expires_in === "number" && answer.expires_in > 0) {
    return now + answer.expires_in * 1000;
  }
  const exp = claimsOf(answer.access_token)?.exp;
  return typeof exp === "number" && exp * 1000 > now ? exp * 1000 : now + HOUR;
}

/**
 * When to renew a token ahead of its end: a fifth of its life before,
 * between a minute and a day, and never within a minute of its issue (one
 * that short is renewed as it's used instead).
 */
export const renewAt = (issued: number, expires: number) =>
  Math.max(issued + MINUTE, expires - Math.min(DAY, Math.max(MINUTE, (expires - issued) / 5)));
