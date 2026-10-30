/**
 * The `chatgpt` model provider (the models plugin's `provider` resource):
 * OpenAI's models on the ChatGPT plan of whom a call is for (in an agent's
 * turn, the person it works for), through ChatGPT's own backend, which
 * speaks OpenAI's Responses protocol and keeps nothing (`store: false`).
 * Every request asks `account.token` for that person's token, fresh: the
 * models plugin knows nothing of accounts. Without a connection the call
 * fails `account_missing` (`account_needs_reconnect` when it lapsed), and a
 * list of models moves on to its next: `["chatgpt/gpt-6.1-sol",
 * "openai/gpt-6.1-sol"]` runs on the person's plan, else the app's key.
 *
 * Its uses are still metered (the usage ledger hears them), tagged
 * `paid: "subscription"` and at no cost to the app (`cost`, the ledger's
 * rates: an app's own replace it).
 */
import type { Caller, Provider } from "../../../models/contract.ts";
import { missing } from "../shared/errors.ts";

/** A model provider whose calls go out with the token of an account provider's account. */
export const accountHeaders =
  (provider: string): (caller: Caller) => Promise<Record<string, string>> =>
  async ({ call }: Caller) => {
    if (!call) throw missing("This call isn't for anyone, so there's no account to use");
    return (await call<{ headers: Record<string, string> }>("account.token", { provider })).headers;
  };

export const chatgptModels: Provider = {
  adapter: "openai",
  catalog: "openai",
  baseURL: "https://chatgpt.com/backend-api/codex",
  options: { store: false },
  tags: { paid: "subscription" },
  headers: accountHeaders("chatgpt"),
};

/** What its uses cost the app: nothing (the person's plan pays). */
export const chatgptCost = { input: 0, output: 0 };
