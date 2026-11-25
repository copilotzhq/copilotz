/**
 * Connected accounts on the web, their logic: how an account stands, what a
 * connection that came back says, whether what was pasted is where a
 * sign-in lands.
 */
import { assertEquals } from "@std/assert";
import { failedWhy, landed, shortAddress, standing, whoOf } from "../accounts/views/web/words.ts";
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
