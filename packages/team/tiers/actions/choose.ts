/**
 * Choosing tiers, and the org's own: all in person.
 *
 * - `tiers.choose` `{ tier, space?, thread?, mine? }`: the tier for the org
 *   (its owners and admins), a space (its managers), a conversation (anyone
 *   in it) or the person's own default for new chats (`mine`); null: the one
 *   above. Those who don't run the org can't choose a tier over its `cap`.
 * - `tiers.cap` `{ tier }`: the highest tier the org's members may choose
 *   (null: any), by its owners and admins.
 * - `tiers.save` `{ tier, title?, description?, kinds?, from? }`: an org's
 *   tier, by its owners and admins: its version of one of the app's, or a
 *   new one (`title`, its chains copied from `from`, else the tier in force).
 *   `kinds`: chains by kind of work (a list of models, tried in order; null:
 *   back to the app's there), each checked as an agent's model is, and each
 *   given the `maxTokens` and `effort` of the chain it replaces, where it
 *   takes it.
 * - `tiers.remove` `{ tier }`: takes one of the app's away, or deletes one
 *   the org made; not the last. Wherever it was chosen, what's above applies.
 * - `tiers.restore` `{ tier }`: one of the app's back as the app has it.
 * - `tiers.kind` `{ kind?, title, base }`: a kind of work of the org's own,
 *   starting from one of the app's (its chain in every tier, until changed).
 * - `tiers.harnesses` `{ harnesses }`: the order the person's plans run
 *   their agents' models in (the app's plans, by provider; the rest after,
 *   in the app's order); null: the app's. Kept on their own choice, beside
 *   their tier for new chats.
 *
 * A change applies from each conversation's next reply.
 */
import { type Context, defineAction, failure, inPerson, invalid } from "copilotz";
import { must, ORG } from "copilotz/plugins/access/contract";
import type { ModelRef } from "copilotz/plugins/models/contract";
import type { ModelChoice } from "../collections/choice.ts";
import { harnessesOf } from "../shared/plans.ts";
import { orgTiersOf } from "../shared/shown.ts";
import {
  aboveCap,
  appKindsOf,
  appTiersOf,
  entryOf,
  ORG_CHOICE,
  personChoice,
  settled,
  spaceChoice,
  type Template,
  threadChoice,
} from "../shared/tiers.ts";

/** Throws unless the caller runs the org. */
const runsOrg = (ctx: Context, what: string) =>
  must(ctx, "manage", ORG, `Only the org's owners and admins ${what}.`);

/** Whether the caller runs the org, without throwing. */
const running = (ctx: Context) => runsOrg(ctx, "do that").then(() => true, () => false);

const choices = (ctx: Context) => ctx.as().db.collection<ModelChoice>("modelChoice");
const templates = (ctx: Context) => ctx.as().db.collection<Template>("tierTemplate");

/** Keeps a level's choice, or deletes it once it holds nothing (no tier, cap or order). */
async function keep(ctx: Context, had: ModelChoice | null, next: ModelChoice) {
  if (!next.tier && !next.cap && !next.harnesses?.length) {
    if (had) await choices(ctx).deleteOne({ _id: next._id });
    return;
  }
  await choices(ctx).replaceOne({ _id: next._id }, next, { upsert: true });
}

/** Sets or clears one level's tier, keeping what else it holds (the org's cap, a person's order). */
async function setTier(ctx: Context, id: string, tier: string | null, more: Partial<ModelChoice>) {
  const had = await choices(ctx).findOne({ _id: id });
  const next = { ...had, ...more, _id: id, at: new Date().toISOString() } as ModelChoice;
  if (tier) next.tier = tier;
  else delete next.tier;
  await keep(ctx, had, next);
}

export const chooseAction = defineAction({
  description: "Chooses the tier for the org, a space, a conversation or your new chats",
  input: {
    type: "object",
    properties: {
      tier: { type: ["string", "null"] },
      space: { type: "string" },
      thread: { type: "string" },
      mine: { type: "boolean" },
    },
    required: ["tier"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const { tiers } = await orgTiersOf(ctx.as());
    if (input.tier !== null && !tiers[input.tier]) {
      throw invalid(`There's no tier "${input.tier}".`);
    }
    const where = [input.space, input.thread, input.mine].filter(Boolean).length;
    if (where > 1) throw invalid("Choose for one place at a time.");
    // Over the cap: only who runs the org.
    if (input.tier) {
      const cap = (await choices(ctx).findOne({ _id: ORG_CHOICE }))?.cap;
      if (aboveCap(tiers, input.tier, cap) && !await running(ctx)) {
        throw failure(
          "forbidden",
          `Your org's owners and admins let members use tiers up to ${tiers[cap!].title}.`,
          { public: true },
        );
      }
    }
    if (input.thread) {
      if (!await ctx.db.collection("thread").findOne({ _id: input.thread })) {
        throw failure("forbidden", "You can't change that conversation.", { public: true });
      }
      await setTier(ctx, threadChoice(input.thread), input.tier, { thread: input.thread });
    } else if (input.mine) {
      const person = ctx.actor!.id;
      await setTier(ctx, personChoice(person), input.tier, { person });
    } else if (input.space) {
      await must(ctx, "manage", input.space, "Only this space's managers choose its tier.");
      await setTier(ctx, spaceChoice(input.space), input.tier, { space: input.space });
    } else {
      await runsOrg(ctx, "choose its default tier");
      await setTier(ctx, ORG_CHOICE, input.tier, {});
    }
    return { tier: input.tier };
  },
});

export const capAction = defineAction({
  description: "Sets the highest tier the org's members may choose",
  input: {
    type: "object",
    properties: { tier: { type: ["string", "null"] } },
    required: ["tier"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsOrg(ctx, "set what members may use");
    const { tiers } = await orgTiersOf(ctx.as());
    if (input.tier !== null && !tiers[input.tier]) {
      throw invalid(`There's no tier "${input.tier}".`);
    }
    const had = await choices(ctx).findOne({ _id: ORG_CHOICE });
    const next = { ...had, _id: ORG_CHOICE, at: new Date().toISOString() } as ModelChoice;
    if (input.tier) next.cap = input.tier;
    else delete next.cap;
    await keep(ctx, had, next);
    return { cap: input.tier };
  },
});

export const harnessesAction = defineAction({
  description: "Sets the order your plans run your agents' models in",
  input: {
    type: "object",
    properties: {
      /** Plans by provider name, first first; null: the app's order. */
      harnesses: { type: ["array", "null"], items: { type: "string" }, maxItems: 32 },
    },
    required: ["harnesses"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const plans = harnessesOf(ctx);
    const order = [...new Set(input.harnesses ?? [])];
    const unknown = order.find((name) => !plans[name]);
    if (unknown) throw invalid(`There's no plan "${unknown}".`);
    const person = ctx.actor!.id;
    const id = personChoice(person);
    const had = await choices(ctx).findOne({ _id: id });
    const next = { ...had, _id: id, person, at: new Date().toISOString() } as ModelChoice;
    if (order.length) next.harnesses = order;
    else delete next.harnesses;
    await keep(ctx, had, next);
    return { harnesses: order.length ? order : null };
  },
});

/** A name for a new tier from its title: `balanced`, `balanced-2`. */
function nameFor(title: string, taken: (name: string) => boolean): string {
  const base = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "tier";
  for (let n = 1;; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!taken(name)) return name;
  }
}

export const saveAction = defineAction({
  description: "Saves one of the org's tiers: its version of the app's, or a new one",
  input: {
    type: "object",
    properties: {
      tier: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 40 },
      description: { type: "string", maxLength: 200 },
      /** Chains by kind of work: models in order; null, back to the app's. */
      kinds: { type: "object", additionalProperties: { type: ["array", "null"], maxItems: 8 } },
      /** A new tier's chains, copied from this one. */
      from: { type: "string" },
    },
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsOrg(ctx, "change its tiers");
    const { tiers, kinds, templates: kept } = await orgTiersOf(ctx.as());
    const app = appTiersOf(ctx);
    const known = (name: string) =>
      !!tiers[name] || !!app[name] || kept.some((t) => t._id === name);
    // A new one: named from its title, its chains from another.
    const making = !input.tier || (!tiers[input.tier] && !app[input.tier]);
    if (making && !input.title) throw invalid("Give the new tier a name.");
    const name = input.tier && !known(input.tier)
      ? input.tier
      : making
      ? nameFor(input.title!, known)
      : input.tier!;
    const had = kept.find((t) => t._id === name);
    const source = input.from ? tiers[input.from] : undefined;
    if (input.from && !source) throw invalid(`There's no tier "${input.from}".`);
    const base = tiers[name] ?? source ?? Object.values(tiers)[0];
    const chains: Record<string, ModelRef> = making ? { ...base?.agents } : { ...had?.agents };
    for (const [kind, chain] of Object.entries(input.kinds ?? {})) {
      if (!kinds[kind]) throw invalid(`There's no kind of work "${kind}".`);
      if (chain === null) {
        delete chains[kind];
        continue;
      }
      const list = chain as ModelRef[];
      if (!list.length) throw invalid("A kind of work needs at least one model.");
      for (const model of list) await ctx.call("models.check", { model, port: "llm" });
      chains[kind] = await settled(ctx, list, entryOf(base, kind, kinds) ?? undefined);
    }
    const order = making
      ? Math.max(0, ...Object.values(tiers).map((t) => t.order ?? 0)) + 1
      : had?.order;
    await templates(ctx).replaceOne({ _id: name }, {
      _id: name,
      ...(input.title ?? had?.title ? { title: input.title ?? had?.title } : {}),
      ...(input.description ?? had?.description
        ? { description: input.description ?? had?.description }
        : {}),
      ...(order !== undefined ? { order } : {}),
      ...(Object.keys(chains).length ? { agents: chains } : {}),
      ...(making || had?.made ? { made: true } : {}),
      at: new Date().toISOString(),
    }, { upsert: true });
    return { tier: name };
  },
});

export const removeAction = defineAction({
  description: "Takes one of the app's tiers away from the org, or deletes one it made",
  input: {
    type: "object",
    properties: { tier: { type: "string" } },
    required: ["tier"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsOrg(ctx, "change its tiers");
    const { tiers } = await orgTiersOf(ctx.as());
    if (!tiers[input.tier]) throw invalid(`There's no tier "${input.tier}".`);
    if (Object.keys(tiers).length === 1) throw invalid("Keep at least one tier.");
    if (tiers[input.tier].made) await templates(ctx).deleteOne({ _id: input.tier });
    else {
      await templates(ctx).updateOne(
        { _id: input.tier },
        { $set: { off: true, at: new Date().toISOString() } },
        { upsert: true },
      );
    }
    return { removed: input.tier };
  },
});

export const restoreAction = defineAction({
  description: "Puts one of the app's tiers back as the app has it",
  input: {
    type: "object",
    properties: { tier: { type: "string" } },
    required: ["tier"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsOrg(ctx, "change its tiers");
    if (!appTiersOf(ctx)[input.tier]) {
      throw invalid(`"${input.tier}" isn't one of the app's tiers.`);
    }
    await templates(ctx).deleteOne({ _id: input.tier });
    return { tier: input.tier };
  },
});

export const kindAction = defineAction({
  description: "Adds or renames a kind of work of the org's own",
  input: {
    type: "object",
    properties: {
      kind: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 40 },
      description: { type: "string", maxLength: 200 },
      base: { type: "string" },
    },
    required: ["title", "base"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    await runsOrg(ctx, "change its kinds of work");
    const app = appKindsOf(ctx);
    if (!app[input.base]) throw invalid(`"${input.base}" isn't one of the app's kinds of work.`);
    const { kinds } = await orgTiersOf(ctx.as());
    const kind = input.kind && !app[input.kind]
      ? input.kind
      : nameFor(input.title, (name) => !!kinds[name]);
    await ctx.as().db.collection("tierKind").replaceOne({ _id: kind }, {
      _id: kind,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      base: input.base,
      at: new Date().toISOString(),
    }, { upsert: true });
    return { kind };
  },
});
