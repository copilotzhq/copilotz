/**
 * `account.connected`: which plans the person a call is for has connected
 * here, for the models plugin's `connectedPlans` resource: the model
 * providers their connected accounts pay for (`["chatgpt"]`). One that needs
 * signing in again isn't: its calls would fail. Whose: the person acting, or
 * the person an agent works for. For trusted code only, and unrecorded.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { AccountDoc } from "../collections/account.ts";
import { personFor, providersOf } from "../shared/settings.ts";

export const connectedAction = defineAction({
  description: "The plans the person a call is for has connected (trusted code only)",
  record: false,
  run: async (ctx): Promise<string[]> => {
    const person = personFor(ctx.actor);
    if (!person) return [];
    const mine = await ctx.as().db.collection<AccountDoc>("account")
      .find({ person, status: "connected" }, { projection: { provider: 1 } });
    const providers = providersOf(ctx);
    return mine.flatMap((account) => providers[account.provider]?.models ?? []);
  },
});
