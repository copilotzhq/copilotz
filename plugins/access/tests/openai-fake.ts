/**
 * A stand-in for OpenAI, for the accounts tests: its OAuth server (sign-in
 * codes bound to their PKCE challenge, tokens, refresh tokens that rotate
 * and can't be used twice, revoking) and ChatGPT's backend (the Responses
 * protocol, for a valid access token of the account its header names).
 * Every token it hands out is unique, so a test can look for it anywhere.
 */
import { serve } from "../../../testing/mod.ts";

export const CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const LANDING = "http://localhost:1455/auth/callback";

/** Who can sign in: their ChatGPT account, email and plan. */
export const PEOPLE: Record<string, { account: string; email: string; plan: string }> = {
  ana: { account: "acct-ana", email: "ana@example.com", plan: "plus" },
  bob: { account: "acct-bob", email: "bob@example.com", plan: "pro" },
};

const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: Record<string, unknown>) =>
  `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(claims))}.`;
const unique = (what: string) => `${what}_${crypto.randomUUID().replaceAll("-", "")}`;

async function s256(verifier: string) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function fakeOpenAI() {
  const codes = new Map<string, { challenge: string; redirect: string; who: string }>();
  const access = new Map<string, { who: string; expires: number; revoked?: boolean }>();
  const refresh = new Map<string, { who: string; used?: boolean; revoked?: boolean }>();
  /** Everything secret it handed out, to look for where it shouldn't be. */
  const secrets: string[] = [];
  const seen = {
    /** Token requests, by grant. */
    grants: [] as string[],
    revoked: [] as string[],
    /** ChatGPT backend calls: whose token, the account header, the body. */
    calls: [] as { who: string; account: string | null; body: Record<string, unknown> }[],
  };
  const settings = { expiresIn: 3600, busy: false, rotate: true };

  const issue = (who: string) => {
    const at = unique(`at_${who}`);
    const rt = unique(`rt_${who}`);
    secrets.push(at, rt);
    access.set(at, { who, expires: Date.now() + settings.expiresIn * 1000 });
    refresh.set(rt, { who });
    const person = PEOPLE[who];
    return json({
      access_token: at,
      refresh_token: rt,
      id_token: jwt({
        email: person.email,
        "https://api.openai.com/auth": {
          chatgpt_account_id: person.account,
          chatgpt_plan_type: person.plan,
        },
      }),
      expires_in: settings.expiresIn,
      token_type: "Bearer",
    });
  };

  /**
   * What the person's browser does at the sign-in address: `who` signs in
   * and allows it, and lands where OpenAI sends them, with a code bound to
   * the sign-in's challenge. Codes are secrets too.
   */
  const signIn = (address: string, who: string): string => {
    const q = new URL(address).searchParams;
    if (
      q.get("client_id") !== CLIENT || q.get("response_type") !== "code" ||
      q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state")
    ) throw new Error(`Not a sign-in OpenAI would take: ${address}`);
    const code = unique("code");
    secrets.push(code);
    const redirect = q.get("redirect_uri")!;
    codes.set(code, { challenge: q.get("code_challenge")!, redirect, who });
    const landing = new URL(redirect);
    landing.searchParams.set("code", code);
    landing.searchParams.set("scope", q.get("scope") ?? "");
    landing.searchParams.set("state", q.get("state")!);
    return landing.toString();
  };

  /** OpenAI ending someone's grant on its side. */
  const revokeAll = (who: string) => {
    for (const held of refresh.values()) if (held.who === who) held.revoked = true;
    for (const held of access.values()) if (held.who === who) held.revoked = true;
  };

  const server = await serve(async (request) => {
    const url = new URL(request.url);
    // For a check in a browser: OpenAI ends someone's grant (their name, as the body).
    if (request.method === "POST" && url.pathname === "/fake/revoke") {
      revokeAll(await request.text());
      return new Response(null, { status: 204 });
    }
    // A browser at the sign-in page: signed in at once (as `login_hint`, Ana by default).
    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      try {
        const landing = signIn(url.href, url.searchParams.get("login_hint") ?? "ana");
        return new Response(null, { status: 302, headers: { location: landing } });
      } catch (error) {
        return new Response((error as Error).message, { status: 400 });
      }
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      if (settings.busy) return json({ error: "temporarily_unavailable" }, 503);
      const form = new URLSearchParams(await request.text());
      seen.grants.push(form.get("grant_type") ?? "");
      if (form.get("client_id") !== CLIENT) return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (
          !code || code.redirect !== form.get("redirect_uri") ||
          code.challenge !== await s256(form.get("code_verifier") ?? "")
        ) {
          return json({ error: "invalid_grant" }, 400);
        }
        return issue(code.who);
      }
      if (form.get("grant_type") === "refresh_token") {
        const held = refresh.get(form.get("refresh_token") ?? "");
        if (!held || held.used || held.revoked) {
          return json({
            error: {
              code: held?.revoked ? "refresh_token_invalidated" : "refresh_token_reused",
              message: "Your refresh token can't be used.",
            },
          }, 401);
        }
        if (settings.rotate) held.used = true;
        return issue(held.who);
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (request.method === "POST" && url.pathname === "/oauth/revoke") {
      const token = new URLSearchParams(await request.text()).get("token") ?? "";
      seen.revoked.push(token);
      const r = refresh.get(token);
      if (r) r.revoked = true;
      const a = access.get(token);
      if (a) a.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (request.method === "POST" && url.pathname === "/backend-api/codex/responses") {
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const held = access.get(bearer);
      if (!held || held.revoked || held.expires < Date.now()) {
        return json({ detail: "Unauthorized" }, 401);
      }
      const account = request.headers.get("chatgpt-account-id");
      if (account !== PEOPLE[held.who].account) return json({ detail: "Wrong account" }, 403);
      const body = await request.json();
      seen.calls.push({ who: held.who, account, body });
      if (body.store !== false) return json({ detail: "Store must be set to false" }, 400);
      const events = [
        { type: "response.output_text.delta", delta: `On ${held.who}'s plan.` },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 12, output_tokens: 5 } },
        },
      ];
      return new Response(
        events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });

  return {
    url: server.url,
    seen,
    secrets,
    settings,
    /** The resources that point the accounts plugin's ChatGPT here. */
    resources: {
      accountProviders: {
        chatgpt: {
          oauth: {
            authorize: `${server.url}/oauth/authorize`,
            token: `${server.url}/oauth/token`,
            revoke: `${server.url}/oauth/revoke`,
          },
        },
      },
      provider: { chatgpt: { baseURL: `${server.url}/backend-api/codex`, retry: 0 } },
    },
    /** Signs `who` in at a sign-in address, and answers where they land. */
    signIn,
    revokeAll,
    close: server.close,
    LANDING,
  };
}

export type FakeOpenAI = Awaited<ReturnType<typeof fakeOpenAI>>;
