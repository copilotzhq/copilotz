/**
 * What a page shows of tiers, read as the person looking: the tiers on offer,
 * each agent's model in them by name, and what a typical reply comes to at
 * this org's prices; what the org and a space chose, and what applies, with
 * where it comes from.
 *
 * A typical reply, for now: 20,000 tokens in, 16,000 of them read from the
 * cache (a conversation's history mostly is), and 1,000 out. One plain profile
 * for every agent, to compare tiers by; it's to be calibrated from the ledger
 * (what replies really take, by agent and effort) once there's enough of it.
 * A tier's price is its agents' average.
 */
import type { ReadContext } from "../../../../runtime/mod.ts";
import type { ModelRef, OfferedModel, Provider } from "../../../models/contract.ts";
import { agentsOf, modelOf } from "../../chat/contract.ts";
import {
  carried,
  type Choice,
  type From,
  type Levels,
  ORG_CHOICE,
  primaryOf,
  resolve,
  spaceChoice,
  tierIn,
  tiersOf,
} from "./tiers.ts";

/** A typical reply's tokens (see above). */
export const REPLY = { input: 20_000, cached: 16_000, output: 1_000 };

/** A model as a page shows it: its name, the effort it's asked for, and a typical reply's price. */
export type ModelShown = {
  id: string;
  name: string;
  effort?: string;
  /** USD, at this org's prices; null when nothing prices it. */
  price: number | null;
  /** It runs on the org's own key: its provider charges for it, not the app. */
  ownKey?: true;
};

export type TierShown = {
  name: string;
  title: string;
  description?: string;
  /** A typical reply, its agents' average (USD); null when none is priced. */
  price: number | null;
  agents: { agent: string; model: ModelShown }[];
};

/** A choice as a page shows it: the tier by name, and each agent's pick. */
export type ChoiceShown = { tier: string | null; custom: Record<string, ModelShown> };

/** One agent's model where it works, and where it comes from (a tier with its title). */
export type AgentNow = { model: ModelShown; from: From & { title?: string } };

export type Shown = {
  tiers: TierShown[];
  /** The app's agents, as they're declared. */
  agents: { agent: string; name: string; icon?: string }[];
  /** The tier the org's plan gives, when the app has plans that say. */
  plan: string | null;
  org: ChoiceShown;
  space?: ChoiceShown;
  /** What applies here: the tier in force and who chose it, and each agent's model. */
  now: {
    tier: { name: string; by: "space" | "org" | "plan" } | null;
    agents: Record<string, AgentNow>;
  };
  reply: typeof REPLY;
};

const choices = (ctx: ReadContext) => ctx.db.collection<Choice>("modelChoice");

/** The org's plan's tier, through the `planTier` resource when something declares it. */
async function planTierOf(ctx: ReadContext): Promise<string | null> {
  const source = ctx.resources.planTier as { action?: string } | undefined;
  return source?.action ? await ctx.call<string | null>(source.action, {}) : null;
}

/** What applies at a level: the org's and the plan's, and the space's when there is one. */
export async function levelsOf(ctx: ReadContext, space?: string): Promise<Levels> {
  const [org, here, plan] = await Promise.all([
    choices(ctx).findOne({ _id: ORG_CHOICE }),
    space ? choices(ctx).findOne({ _id: spaceChoice(space) }) : null,
    planTierOf(ctx),
  ]);
  return { org, ...(space ? { space: here } : {}), plan };
}

/** Names and prices for models, by `"provider/model"` and effort, each asked once. */
async function modelsShown(
  ctx: ReadContext,
  refs: ModelRef[],
): Promise<(ModelShown | undefined)[]> {
  const primaries = refs.map((ref) => primaryOf(ctx, ref));
  const ids = [...new Set(primaries.flatMap((p) => p ? [p.id] : []))];
  const offered = await Promise.all(
    ids.map((model) =>
      ctx.call<{ model: OfferedModel | null }>("models.offered", { model })
        .then((answer) => answer.model, () => null)
    ),
  );
  const known = new Map(ids.map((id, i) => [id, offered[i]]));
  const declared = (ctx.resources.provider ?? {}) as Record<string, Provider>;
  // What a typical reply is charged, for those the app charges for, when there's a ledger.
  const charged = ctx.resources.usage ? ids.filter((id) => !known.get(id)?.ownKey) : [];
  const quoted = charged.length
    ? await ctx.call<(number | null)[]>("usage.quotes", {
      uses: charged.map((id) => {
        const slash = id.indexOf("/");
        const from = declared[id.slice(0, slash)]?.catalog;
        return {
          meter: "llm",
          subject: id,
          catalog: `${typeof from === "string" ? from : id.slice(0, slash)}${id.slice(slash)}`,
          quantities: REPLY,
        };
      }),
    }).catch(() => charged.map(() => null))
    : [];
  const prices = new Map(charged.map((id, i) => [id, quoted[i] ?? null]));
  return primaries.map((p) => {
    if (!p) return undefined;
    const info = known.get(p.id);
    return {
      id: p.id,
      name: info?.name ?? p.id.slice(p.id.indexOf("/") + 1),
      ...(p.effort ? { effort: p.effort } : {}),
      price: prices.get(p.id) ?? null,
      ...(info?.ownKey ? { ownKey: true as const } : {}),
    };
  });
}

/** The average of what's priced; null when nothing is. */
const average = (prices: (number | null)[]) => {
  const priced = prices.filter((p): p is number => p !== null);
  return priced.length ? priced.reduce((a, b) => a + b, 0) / priced.length : null;
};

/** Everything a page shows, at the org's level, or a space's. */
export async function shownAt(ctx: ReadContext, space?: string): Promise<Shown> {
  const tiers = Object.entries(tiersOf(ctx))
    .sort(([a, x], [b, y]) => (x.order ?? 0) - (y.order ?? 0) || a.localeCompare(b));
  const agents = agentsOf(ctx);
  const levels = await levelsOf(ctx, space);
  // What each agent uses now, a pick with what it carries over.
  const now = await Promise.all(
    Object.keys(agents).map(async (agent) => {
      const found = resolve(ctx, agent, levels);
      return { agent, from: found.from, model: await carried(ctx, found) };
    }),
  );
  const custom = (choice?: Choice | null) =>
    Object.entries(choice?.custom ?? {}).filter(([agent]) => agents[agent]);
  // Every model shown, asked for at once, and taken back in the same order.
  const refs: ModelRef[] = [
    ...tiers.flatMap(([, tier]) => Object.values(tier.agents)),
    ...custom(levels.org).map(([, ref]) => ref),
    ...custom(levels.space).map(([, ref]) => ref),
    ...now.map((n) => n.model ?? modelOf(agents[n.agent])),
  ];
  const shown = await modelsShown(ctx, refs);
  let cursor = 0;
  const next = () => shown[cursor++];
  const tiersShown = tiers.map(([name, tier]) => {
    const listed = Object.keys(tier.agents).map((agent) => ({ agent, model: next() }))
      .filter((a): a is { agent: string; model: ModelShown } => !!a.model && !!agents[a.agent]);
    return {
      name,
      title: tier.title,
      ...(tier.description ? { description: tier.description } : {}),
      price: average(listed.map((a) => a.model.price)),
      agents: listed,
    };
  });
  const choiceShown = (choice?: Choice | null): ChoiceShown => ({
    tier: choice?.tier && Object.hasOwn(tiersOf(ctx), choice.tier) ? choice.tier : null,
    custom: Object.fromEntries(
      custom(choice).flatMap(([agent]) => {
        const model = next();
        return model ? [[agent, model]] : [];
      }),
    ),
  });
  const org = choiceShown(levels.org);
  const here = space ? choiceShown(levels.space) : undefined;
  const inForce = tierIn(tiersOf(ctx), levels);
  return {
    tiers: tiersShown,
    agents: Object.entries(agents).map(([agent, def]) => ({
      agent,
      name: def.name ?? agent[0].toUpperCase() + agent.slice(1),
      ...(def.icon ? { icon: def.icon } : {}),
    })),
    plan: levels.plan && Object.hasOwn(tiersOf(ctx), levels.plan) ? levels.plan : null,
    org,
    ...(here ? { space: here } : {}),
    now: {
      tier: inForce ? { name: inForce.tier, by: inForce.by } : null,
      agents: Object.fromEntries(now.flatMap((n) => {
        const model = next();
        return model ? [[n.agent, { model, from: titled(ctx, n.from) }]] : [];
      })),
    },
    reply: REPLY,
  };
}

/** Where a model comes from, with its tier's title when it's a tier's. */
const titled = (ctx: ReadContext, from: From): AgentNow["from"] =>
  "tier" in from && from.tier ? { ...from, title: tiersOf(ctx)[from.tier]?.title } : from;

/**
 * One of the app's agents where it works in a space: its model, where that
 * comes from, and, when it's picked for the space, what it would be without
 * (`without`: where taking the pick back leaves it).
 */
export async function agentAt(
  ctx: ReadContext,
  agent: string,
  space: string,
): Promise<AgentNow & { without?: AgentNow } | null> {
  const own = agentsOf(ctx)[agent];
  if (!own) return null;
  const levels = await levelsOf(ctx, space);
  const now = resolve(ctx, agent, levels);
  const picked = levels.space?.custom?.[agent] !== undefined;
  const { [agent]: _, ...others } = levels.space?.custom ?? {};
  const before = picked
    ? resolve(ctx, agent, { ...levels, space: { ...levels.space, custom: others } })
    : undefined;
  const [shown, without] = await modelsShown(ctx, [
    await carried(ctx, now) ?? modelOf(own),
    ...(before ? [await carried(ctx, before) ?? modelOf(own)] : []),
  ]);
  if (!shown) return null;
  return {
    model: shown,
    from: titled(ctx, now.from),
    ...(before && without ? { without: { model: without, from: titled(ctx, before.from) } } : {}),
  };
}
