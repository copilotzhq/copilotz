/**
 * Connected accounts: a person connects an outside account once, and agents
 * working for them use it. The first is their ChatGPT plan, as a model
 * provider: agents run on it instead of the app's API key.
 *
 * - **Accounts** (`account`): one per person and provider: who it is there
 *   (a label, a plan), how it stands (`connected`, `needs_reconnect`,
 *   `revoked`), when it was signed in and renewed. Its tokens are a private
 *   field, sealed with the app's `accounts.key` when it has one: no actor's
 *   read, no View and no event gets them, only this plugin's Actions. Each
 *   person reads their own; nobody else, agents included, reaches anyone's.
 * - **Providers** are a resource (`accountProviders`): OAuth's endpoints,
 *   the client, its scopes, how to tell who the account is, the headers its
 *   token goes in, and the model providers it pays for. ChatGPT is
 *   declared; GitHub, Google and others are more of the same.
 * - **Connecting** (`account.connect`) is OAuth's code flow with PKCE, the
 *   state bound to the person who started it, used once, within ten
 *   minutes. The provider sends them back to the app's callback (the web
 *   host's route, `/accounts/callback/<provider>`: `account.callback`), or,
 *   for one that only sends people to a fixed address the app can't serve
 *   (ChatGPT's), they paste that address back (`account.complete`).
 * - **Renewing:** each account's timer renews its tokens before they run
 *   out (`account.refresh`), and a token used too close to its end is
 *   renewed first; one renewal at a time, never over a newer one. A refused
 *   refresh token leaves the account needing to be signed in again.
 * - **Disconnecting** (`account.disconnect`) asks the provider to end its
 *   tokens and removes the account.
 * - **Using it:** `account.token`, for trusted code only, answers the
 *   token (and headers) of whom a call is for: the person, or the person an
 *   agent works for. The `chatgpt` model provider asks it on every request
 *   (resources/models.ts); without a connection the call fails
 *   `account_missing`, and a list of models moves on. Its uses are metered
 *   as the person's plan's (`paid: "subscription"`), at no cost to the app.
 * - `account.changed` says when an account is connected, lost or
 *   disconnected: the audit trail, with nothing secret in it.
 *
 * Its web front end is `accountsWeb` (web.tsx): the Connected accounts page,
 * and in a chat, a quiet word when its agents run on your plan.
 *
 * ```ts
 * plugins: [...access, accounts, definePlugin({ name: "app", resources: {
 *   accounts: { key: secrets.accountsKey },
 *   agents: { lead: { instructions, model: ["chatgpt/gpt-6.1-sol", "openai/gpt-6.1-sol"] } },
 * } })]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { CALLBACK, callbackAction } from "./actions/callback.ts";
import { completeAction } from "./actions/complete.ts";
import { connectAction } from "./actions/connect.ts";
import { disconnectAction } from "./actions/disconnect.ts";
import { refreshAction } from "./actions/refresh.ts";
import { tokenAction } from "./actions/token.ts";
import { account } from "./collections/account.ts";
import { accountFlow } from "./collections/flow.ts";
import { changed } from "./events/changed.ts";
import { chatgpt } from "./resources/chatgpt.ts";
import { chatgptCost, chatgptModels } from "./resources/models.ts";
import { rules } from "./shared/rules.ts";
import { providersOf } from "./shared/settings.ts";

export * from "./contract.ts";
export type { AccountsSettings } from "./shared/settings.ts";
export { accountHeaders } from "./resources/models.ts";

/** Whether an address is one to send codes and tokens to: https (or this machine's http). */
const sendable = (address: unknown) => {
  try {
    const url = new URL(String(address));
    return url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
};

export const accounts: Plugin = definePlugin({
  name: "accounts",
  collections: { account, accountFlow },
  actions: {
    "account.connect": connectAction,
    "account.complete": completeAction,
    "account.callback": callbackAction,
    "account.disconnect": disconnectAction,
    "account.refresh": refreshAction,
    "account.token": tokenAction,
  },
  events: { "account.changed": changed },
  guard: rules,
  resources: {
    accounts: {},
    accountProviders: { chatgpt },
    provider: { chatgpt: chatgptModels },
    cost: { "chatgpt/*": chatgptCost },
    routes: { accounts: { path: CALLBACK, action: "account.callback", methods: ["GET"] } },
  },
  check(merged) {
    for (const [name, provider] of Object.entries(providersOf(merged))) {
      const { oauth } = provider;
      const where = `accountProviders.${name}`;
      if (!provider.title || !provider.allows) {
        throw new Error(`${where}: needs a title and allows`);
      }
      if (!oauth?.clientId) throw new Error(`${where}: needs oauth.clientId`);
      for (const field of ["authorize", "token", "revoke"] as const) {
        if ((field !== "revoke" || oauth.revoke !== undefined) && !sendable(oauth[field])) {
          throw new Error(`${where}: oauth.${field} must be an https address`);
        }
      }
      if (oauth.redirect !== undefined && !sendable(oauth.redirect)) {
        throw new Error(`${where}: oauth.redirect must be an https (or loopback) address`);
      }
      if (typeof provider.profile !== "function") throw new Error(`${where}: needs a profile`);
    }
  },
});

export default accounts;
