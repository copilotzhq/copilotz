/**
 * `account.refresh`: renews an account's tokens before they run out, called
 * by its timer (set as it's connected and each time it's renewed). A
 * provider that can't be reached now loses nothing: it's tried again in a
 * quarter of an hour (and as the tokens are used). One that refuses the
 * refresh token leaves the account needing to be signed in again.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { AccountDoc } from "../collections/account.ts";
import { codeOf } from "../shared/errors.ts";
import { renew } from "../shared/renew.ts";
import { providersOf, timerOf } from "../shared/settings.ts";

/** How soon a renewal that couldn't reach its provider is tried again. */
const AGAIN_MS = 15 * 60_000;

export const refreshAction = defineAction({
  description: "Renews an account's tokens before they run out (its timer calls it)",
  input: {
    type: "object",
    properties: { account: { type: "string" } },
    required: ["account"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const system = ctx.as();
    const account = await system.db.collection<AccountDoc>("account").findOne({
      _id: input.account,
    });
    if (account?.status !== "connected") return { status: account?.status ?? "gone" };
    const provider = providersOf(ctx)[account.provider];
    if (!provider) return { status: "unknown" };
    try {
      await renew(system, account, provider);
      return { status: "connected" };
    } catch (error) {
      if (codeOf(error) === "account_needs_reconnect" || codeOf(error) === "account_missing") {
        return { status: "lost" };
      }
      const at = new Date(Date.now() + AGAIN_MS).toISOString();
      await system.schedule("account.refresh", { account: account._id }, {
        at,
        id: timerOf(account._id),
      });
      return { status: "connected", again: at };
    }
  },
});
