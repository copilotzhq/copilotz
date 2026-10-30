/**
 * ChatGPT: a person's ChatGPT plan, which agents working for them run on
 * (the `chatgpt` model provider, resources/models.ts) instead of the app's
 * API key.
 *
 * OpenAI lets a ChatGPT plan be used outside ChatGPT only through its Codex
 * sign-in: Codex's public client, which sends people back to Codex's own
 * address on their computer (`http://localhost:1455/auth/callback`), never
 * to a web app's. So the person signs in at OpenAI, lands on that address
 * (a page that doesn't load, since Codex isn't listening), and pastes it
 * back: its code is useless to anyone without the sign-in's PKCE verifier,
 * which never leaves the server. Its ID token says who the account is: the
 * email, the ChatGPT account its calls name (`chatgpt-account-id`) and the
 * plan.
 */
import type { AccountProvider } from "../contract.ts";
import { claimsOf } from "../shared/oauth.ts";

/** Plans as people know them. */
const PLANS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

export const chatgpt: AccountProvider = {
  title: "ChatGPT",
  allows: "Agents working for you run on your ChatGPT plan instead of the app's API key.",
  note: "OpenAI will ask you to allow Codex: that's how a ChatGPT plan is used outside ChatGPT.",
  icon: "sparkles",
  models: ["chatgpt"],
  oauth: {
    authorize: "https://auth.openai.com/oauth/authorize",
    token: "https://auth.openai.com/oauth/token",
    revoke: "https://auth.openai.com/oauth/revoke",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    // Who you are, and staying signed in: nothing more.
    scopes: ["openid", "profile", "email", "offline_access"],
    params: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    redirect: "http://localhost:1455/auth/callback",
  },
  profile: (answer) => {
    const claims = claimsOf(answer.id_token) ?? {};
    const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    const id = auth.chatgpt_account_id;
    if (typeof id !== "string" || !id) throw new Error("No ChatGPT account in the ID token");
    const plan = typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
    return {
      id,
      label: typeof claims.email === "string" ? claims.email : "ChatGPT account",
      ...(plan ? { plan: PLANS[plan] ?? plan } : {}),
    };
  },
  headers: (token, id) => ({
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": id,
    // ChatGPT's backend serves Codex: it's told the client the way Codex tells it.
    originator: "codex_cli_rs",
  }),
};
