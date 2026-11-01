/**
 * An org's own keys for model providers (see collections/model-key.ts), as the
 * models plugin's `modelKeys` resource names them. Its owners and admins change
 * them, in person: `modelKey.set` `{ provider, key }` and `modelKey.remove`
 * `{ provider }`; `modelKey.may` says whether the person asking can. For
 * trusted code only: `modelKey.list` (nothing secret) and `modelKey.open`.
 *
 * All unrecorded: a key is in no event, as its input or its answer.
 */
import {
  type Context,
  defineAction,
  forbidden,
  inPerson,
  invalid,
  people,
} from "../../../../runtime/mod.ts";
import { runsOrg } from "../../spaces/contract.ts";
import type { ModelKeyDoc } from "../collections/model-key.ts";
import { seal, unseal } from "../shared/seal.ts";
import { settingsOf } from "../shared/settings.ts";

const keysOf = (ctx: Context) => ctx.as().db.collection<ModelKeyDoc>("modelKey");

/** What a sealed key is bound to, so it can't be moved to another provider or org. */
const boundTo = (ctx: Context, provider: string) =>
  `modelKey:${(ctx.resources.org as { id?: string } | undefined)?.id ?? ""}:${provider}`;

/** Whether whoever asks runs the org: only they change its keys. */
const runs = (ctx: Context) =>
  ctx.call<{ role?: string | null; staff?: boolean }>("org.me", {})
    .then((me) => !!me.staff || runsOrg(me.role ?? null), () => false);

const SHOW = 4;
/** A long key's last characters, to tell it apart; a short one shows nothing of itself. */
const hintOf = (key: string) => key.length >= 16 ? `••••${key.slice(-SHOW)}` : "••••";

export const modelKeySet = defineAction({
  description: "Adds or replaces the org's own key for a model provider",
  record: false,
  input: {
    type: "object",
    properties: {
      provider: { type: "string" },
      key: { type: "string", minLength: 1, maxLength: 4096 },
    },
    required: ["provider", "key"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (!await runs(ctx)) throw forbidden("Only the org's owners and admins change its keys.");
    if (!await ctx.call<boolean>("models.keyable", { provider: input.provider })) {
      throw invalid(`A key can't be added for "${input.provider}".`);
    }
    const key = input.key.trim();
    if (!key || /\s/.test(key)) throw invalid("That doesn't look like a key.");
    const sealed = await seal(settingsOf(ctx).key, boundTo(ctx, input.provider), {
      access: key,
      account: input.provider,
    });
    const hint = hintOf(key);
    await keysOf(ctx).updateOne(
      { _id: input.provider },
      { $set: { sealed, hint, by: ctx.actor!.id, at: new Date().toISOString() } },
      { upsert: true },
    );
    return { provider: input.provider, hint };
  },
});

export const modelKeyRemove = defineAction({
  description: "Removes the org's own key for a model provider",
  record: false,
  input: {
    type: "object",
    properties: { provider: { type: "string" } },
    required: ["provider"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    if (!await runs(ctx)) throw forbidden("Only the org's owners and admins change its keys.");
    await keysOf(ctx).deleteOne({ _id: input.provider });
    return { removed: true };
  },
});

export const modelKeyMay = defineAction({
  description: "Whether you may change the org's keys for model providers",
  record: false,
  input: { type: "object", additionalProperties: false },
  allow: people,
  run: async (ctx) => ({ set: await runs(ctx) }),
});

// No `allow`: only the system (a model call, the models plugin) asks these.
export const modelKeyList = defineAction({
  record: false,
  input: { type: "object", additionalProperties: false },
  run: async (ctx) =>
    (await keysOf(ctx).find({})).map((k) => ({
      provider: k._id,
      ...(k.hint ? { hint: k.hint } : {}),
    })),
});

export const modelKeyOpen = defineAction({
  record: false,
  input: {
    type: "object",
    properties: { provider: { type: "string" } },
    required: ["provider"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const found = await keysOf(ctx).findOne({ _id: input.provider });
    if (!found) return null;
    const { access } = await unseal(
      settingsOf(ctx).key,
      boundTo(ctx, input.provider),
      found.sealed,
    );
    return access;
  },
});
