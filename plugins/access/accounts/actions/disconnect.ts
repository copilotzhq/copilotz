/**
 * `account.disconnect`: the person disconnects one of their accounts. The
 * provider is told to end its tokens (as far as it will in a few seconds:
 * disconnecting never waits on it), and the account goes, with its renewal
 * timer, saying `account.changed`. Agents working for them then use the
 * app's own models, where it has them.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Changed } from "../contract.ts";
import type { AccountDoc } from "../collections/account.ts";
import { revoke } from "../shared/oauth.ts";
import { unseal } from "../shared/seal.ts";
import { accountId, providerOf, settingsOf, timerOf } from "../shared/settings.ts";

export const disconnectAction = defineAction({
  description: "Disconnects one of your accounts, and asks its provider to end its sign-in",
  input: {
    type: "object",
    properties: { provider: { type: "string" } },
    required: ["provider"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    const person = ctx.actor!.id;
    const provider = providerOf(ctx, input.provider);
    const _id = accountId(person, input.provider);
    const account = await ctx.db.collection<AccountDoc>("account").findOne({ _id });
    if (!account) return { disconnected: false };
    if (account.tokens) {
      const held = await unseal(settingsOf(ctx).key, _id, account.tokens).catch(() => undefined);
      // Its refresh token ends what it gave, at providers that follow RFC 7009; the access token too.
      if (held?.refresh) await revoke(provider, held.refresh, "refresh_token").catch(() => {});
      if (held?.access) await revoke(provider, held.access, "access_token").catch(() => {});
    }
    await ctx.transaction(async (tx) => {
      await tx.db.collection("account").deleteOne({ _id });
      tx.unschedule(timerOf(_id));
      tx.emit("account.changed", {
        _id,
        person,
        provider: input.provider,
        status: "disconnected",
      } as Changed);
    });
    return { disconnected: true };
  },
});
