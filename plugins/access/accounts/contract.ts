/**
 * The accounts plugin's contract: what plugins built on it may import: the
 * shape of an account (as its person reads it: never its tokens), of the
 * `accountProviders` resource kind, and of its Actions' answers. They reach
 * the rest by name:
 *
 * - the `account` collection, each person reading their own;
 * - its queries `account.providers` (what can be connected, and how) and
 *   `account.uses` (which models would run on the asker's accounts);
 * - its Actions `account.connect`, `account.complete`, `account.disconnect`
 *   (a person's), and `account.token` (trusted code only: a model provider,
 *   a tool calling the provider's API for its person);
 * - its event `account.changed`, as an account is connected, lost or
 *   disconnected.
 *
 * A provider is a resource: the OAuth endpoints, the client, its scopes, how
 * to tell who the account is, and the headers its token goes in:
 *
 * ```ts
 * resources: {
 *   accountProviders: {
 *     github: {
 *       title: "GitHub",
 *       allows: "Agents working for you read and push to your repositories.",
 *       oauth: { authorize: "https://github.com/login/oauth/authorize", token: "…", clientId, clientSecret, scopes: ["repo"] },
 *       profile: async (answer) => …,
 *     },
 *   },
 * }
 * ```
 */
import type { IconName } from "../../../hosts/web/mod.ts";
import type { ModelRef } from "../../models/contract.ts";

/** Whether an account can be used: it can, it needs signing in again, or the provider ended it. */
export type Status = "connected" | "needs_reconnect" | "revoked";

/** An account, as its person reads it (`account`): who it is there, and how it stands. */
export type Account = {
  _id: string;
  person: string;
  /** Its provider: an `accountProviders` name (`chatgpt`). */
  provider: string;
  status: Status;
  /** Who it is there, as people know it: an email, a username. */
  label: string;
  /** Its plan there, when the provider says ("Plus"). */
  plan?: string;
  /** Why it needs signing in again, in words. */
  problem?: string;
  /** When it was signed in, and its tokens last renewed. */
  connected: string;
  refreshed?: string;
  /** When its access token runs out (it's renewed before). */
  expires?: string;
};

/** OAuth 2.0 with PKCE, as a provider declares it. */
export type OAuth = {
  /** Where the person signs in, and where codes and refresh tokens become tokens. */
  authorize: string;
  token: string;
  /** Where tokens are revoked when the person disconnects (RFC 7009), if the provider has one. */
  revoke?: string;
  clientId: string;
  /** A confidential client's secret: it stays on the server, in the resource. */
  clientSecret?: string;
  scopes?: string[];
  /** More parameters for the sign-in address. */
  params?: Record<string, string>;
  /**
   * Where the provider sends the person back. By default, this app's own
   * callback (`<app>/accounts/callback/<name>`, the web host's route). A
   * fixed address the app can't serve (a command-line tool's loopback): the
   * person lands there and pastes its address back into the app.
   */
  redirect?: string;
};

/** What a token endpoint answers (RFC 6749), and anything else it says. */
export type TokenAnswer = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  [more: string]: unknown;
};

/** Who an account is at its provider: its id there, a label people know it by, its plan. */
export type Profile = { id: string; label: string; plan?: string };

/** An `accountProviders` resource: a kind of account people connect. */
export type AccountProvider = {
  /** Its name, as people know it: "ChatGPT". */
  title: string;
  /** What connecting it lets agents do, in a sentence, said before connecting. */
  allows: string;
  /** Anything else worth knowing first, in a sentence. */
  note?: string;
  /** The toolkit's icon it's shown with (a plain one: never a brand's mark). */
  icon?: IconName;
  /** The model providers (`provider` resources) it pays for: agents using them run on it. */
  models?: string[];
  oauth: OAuth;
  /** Who the account is, from what the token endpoint answered (and the provider's API). */
  profile(answer: TokenAnswer): Profile | Promise<Profile>;
  /**
   * The headers a call with its token sends, given the token and the
   * account's id there (default: `authorization: Bearer <token>`).
   */
  headers?(token: string, id: string): Record<string, string>;
};

/** A provider as `account.providers` shows it: what to say, and how connecting goes. */
export type ProviderShown = {
  name: string;
  title: string;
  allows: string;
  note?: string;
  icon?: IconName;
  /** The person pastes back the address they land on, which starts with this. */
  paste?: string;
  models?: string[];
};

/** What `account.connect` answers: where to sign in, and (to paste back) where the person lands. */
export type Connecting = { url: string; paste?: string };

/** `account.uses`: for each agent, the account its model would run on, or one that needs reconnecting. */
export type Uses = Record<string, Use>;
export type Use = {
  provider: string;
  title: string;
  label?: string;
  plan?: string;
  /** It would run there, but the account needs signing in again: it runs on the app's instead. */
  reconnect?: true;
};

/** `account.uses`' params: the models agents use, by agent. */
export type UsesParams = { models: Record<string, ModelRef> };

/** `account.changed`: an account connected, lost (needs reconnecting, revoked) or disconnected. */
export type Changed = {
  _id: string;
  person: string;
  provider: string;
  status: Status | "disconnected";
};
