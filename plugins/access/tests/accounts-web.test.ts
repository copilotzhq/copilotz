/**
 * Connected accounts on the web, their logic: how an account stands, what a
 * connection that came back says, whether what was pasted is where a
 * sign-in lands, the quiet word over a chat's composer, and which of a
 * model choice's models are tried, in order.
 */
import { assertEquals } from "@std/assert";
import {
  failedWhy,
  landed,
  shortAddress,
  standing,
  usesLine,
  whoOf,
} from "../accounts/views/web/words.ts";
import { idsOf, usesOf } from "../accounts/shared/uses.ts";
import { chatgpt } from "../accounts/resources/chatgpt.ts";
import { signIn } from "../accounts/shared/oauth.ts";
import { test } from "../../../testing/mod.ts";

const LANDING = "http://localhost:1455/auth/callback";

test("how an account stands, and who it is", () => {
  assertEquals(standing({ status: "connected" }), { label: "Connected", tone: "success" });
  assertEquals(standing({ status: "needs_reconnect" }).label, "Needs signing in");
  assertEquals(standing({ status: "revoked" }).label, "Access ended");
  assertEquals(standing(undefined).label, "Not connected");
  assertEquals(whoOf({ label: "ana@example.com", plan: "Plus" }), "ana@example.com · Plus plan");
  assertEquals(whoOf({ label: "ana" }), "ana");
});

test("what a connection that came back says, by its code", () => {
  assertEquals(
    failedWhy("signed_out", "Forge"),
    "You were signed out when Forge sent you back. Sign in, then connect it again.",
  );
  assertEquals(failedWhy("nonsense", "Forge"), "Forge couldn't be connected. Try again.");
});

test("what was pasted: the address a sign-in lands on, another page's, or not one yet", () => {
  assertEquals(landed(`${LANDING}?code=c&scope=x&state=s`, LANDING), "yes");
  assertEquals(landed(`  ${LANDING}?error=access_denied&state=s\n`, LANDING), "yes");
  assertEquals(landed(`https://example.com/auth/callback?code=c&state=s`, LANDING), "elsewhere");
  assertEquals(landed(`${LANDING}?code=c`, LANDING), "no");
  assertEquals(landed("c0de", LANDING), "no");
  assertEquals(shortAddress(LANDING), "localhost:1455/auth/callback");
});

test("over a chat's composer: who runs on the person's plan, or whose needs reconnecting", () => {
  const on = { provider: "chatgpt", title: "ChatGPT", label: "ana@example.com", plan: "Plus" };
  const lapsed = { provider: "chatgpt", title: "ChatGPT", reconnect: true as const };
  assertEquals(usesLine({ lead: on }, ["lead"])?.text, "Runs on your ChatGPT Plus plan");
  assertEquals(
    usesLine({ lead: on, maya: on }, ["lead", "maya", "bob"], (a) => a.toUpperCase())?.text,
    "LEAD and MAYA run on your ChatGPT Plus plan",
  );
  assertEquals(
    usesLine({ lead: on }, ["lead", "maya"])?.text,
    "lead runs on your ChatGPT Plus plan",
  );
  assertEquals(usesLine({ lead: lapsed }, ["lead"])?.tone, "reconnect");
  assertEquals(usesLine({}, ["lead"]), undefined);
});

test("a model choice's models, as they're tried: aliases, settings and lists followed", () => {
  const aliases = {
    plan: ["chatgpt/gpt-6.1-sol", "cheap"],
    cheap: { model: "openai/gpt-5.4-mini" },
    loop: "loop",
  };
  assertEquals(idsOf({ model: "plan", effort: "low" }, aliases), [
    "chatgpt/gpt-6.1-sol",
    "openai/gpt-5.4-mini",
  ]);
  assertEquals(idsOf("loop", aliases), []);
  assertEquals(idsOf(undefined), []);
  // Which account each agent's would run on, for a person with a connected ChatGPT.
  const ctx = { resources: { accountProviders: { chatgpt }, model: aliases } };
  const mine = [{ provider: "chatgpt", status: "connected" as const, label: "ana@example.com" }];
  assertEquals(usesOf(ctx, mine, { models: { a: "plan", b: "cheap", c: ["cheap", "plan"] } }), {
    a: { provider: "chatgpt", title: "ChatGPT", label: "ana@example.com" },
  });
});

test("ChatGPT's sign-in: OpenAI's, for Codex's client, landing on Codex's address, with PKCE", () => {
  const url = new URL(
    signIn(chatgpt, { state: "s", challenge: "c", redirect: chatgpt.oauth.redirect! }),
  );
  assertEquals(`${url.origin}${url.pathname}`, "https://auth.openai.com/oauth/authorize");
  assertEquals(Object.fromEntries(url.searchParams), {
    response_type: "code",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirect_uri: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
    code_challenge: "c",
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    state: "s",
  });
  // Who an account is: its ChatGPT account, email and plan, from the ID token.
  const claims = btoa(JSON.stringify({
    email: "ana@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
  })).replace(/=+$/, "");
  assertEquals(chatgpt.profile({ access_token: "a", id_token: `x.${claims}.y` }), {
    id: "acct-1",
    label: "ana@example.com",
    plan: "Pro",
  });
  assertEquals(chatgpt.headers!("tok", "acct-1"), {
    authorization: "Bearer tok",
    "chatgpt-account-id": "acct-1",
    originator: "codex_cli_rs",
  });
});
