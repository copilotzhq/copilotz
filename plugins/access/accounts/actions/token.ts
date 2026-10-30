/**
 * `account.token`: the access token of the account whom a call is for has at
 * a provider, fresh, and the headers to send it in. For trusted code only
 * (a model provider, a tool calling the provider's API for its person):
 * nobody may call it from outside, and it's unrecorded, so the token is in
 * no event. Whose: the person acting, or the person an agent works for; the
 * system names one (`person`).
 *
 * Fails with `account_missing` when they have none connected (or the call
 * is for nobody), `account_needs_reconnect` when it must be signed in again,
 * and `account_unavailable` when its provider can't renew it now: a list of
 * models moves on to its next.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { AccountDoc } from "../collections/account.ts";
import { lapsed, missing } from "../shared/errors.ts";
import { SKEW } from "../shared/oauth.ts";
import { renew } from "../shared/renew.ts";
import { unseal } from "../shared/seal.ts";
import { accountId, personFor, providerOf, settingsOf } from "../shared/settings.ts";

export const tokenAction = defineAction({
  description: "The access token whom a call is for has at a provider (trusted code only)",
  record: false,
  input: {
    type: "object",
    properties: { provider: { type: "string" }, person: { type: "string" } },
    required: ["provider"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const provider = providerOf(ctx, input.provider);
    const person = personFor(ctx.actor, input.person);
    if (!person) {
      throw missing(`This isn't for anyone, so there's no ${provider.title} account to use`);
    }
    const system = ctx.as();
    const _id = accountId(person, input.provider);
    const account = await system.db.collection<AccountDoc>("account").findOne({ _id });
    if (!account) {
      throw missing(`No ${provider.title} account is connected: connect one in Connected accounts`);
    }
    if (account.status !== "connected" || !account.tokens) {
      throw lapsed(
        `Your ${provider.title} account needs signing in again: reconnect it in Connected accounts`,
      );
    }
    const due = !account.expires || Date.parse(account.expires) - SKEW <= Date.now();
    const held = due
      ? await renew(system, account, provider)
      : await unseal(settingsOf(ctx).key, _id, account.tokens);
    return {
      token: held.access,
      headers: provider.headers?.(held.access, held.account) ??
        { authorization: `Bearer ${held.access}` },
    };
  },
});
