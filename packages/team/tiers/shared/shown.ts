/**
 * What a page shows of tiers, read as the person looking: the org's tiers
 * (the app's as the org keeps them, and those it made), each kind of work's
 * model chain in them by name, and what a typical message comes to at this
 * org's prices; the kinds of work and the app's agents of each; what the org,
 * a space, a conversation and the person chose, and what applies; and what
 * the org's plan gives in credits, so a page can say how far they go.
 *
 * A typical message is what the app measured one takes (its `typicalMessage`
 * resource): each agent's calls per message, and each call's tokens, priced
 * at the agent's model in each tier. A tier's price is the sum. Without one,
 * a plain reply for comparing tiers: 20,000 tokens in, 16,000 of them read
 * from the cache (a conversation's history mostly is), and 1,000 out, each
 * agent's alike, and a tier's price is its agents' average.
 *
 * With the person's plans (`plansFor`: those they can run now, in their
 * order, and the models those that said so run), each chain is also priced
 * as their turns would run it: at the
 * first model it would try for them (`models.check`, plans first), one of
 * their plans costing them nothing (`plan`), and a tier's price for them
 * (`yours`) beside the app's (`price`, which pages choosing for others show).
 */
import type { ReadContext } from "copilotz";
import type { ModelRef, OfferedModel, Provider } from "copilotz/plugins/models/contract";
import { agentsOf } from "copilotz/plugins/agents/contract";
import { personOf } from "copilotz";
import { type Plans, plansFor } from "./plans.ts";
import {
  type By,
  type Choice,
  entryOf,
  type Kind,
  kindOf,
  kindsIn,
  type Levels,
  ORG_CHOICE,
  type OrgKind,
  type OrgTier,
  personChoice,
  primaryOf,
  spaceChoice,
  type Template,
  threadChoice,
  tierIn,
  tiersIn,
} from "./tiers.ts";

/** A typical reply's tokens, where the app measured no message (see above). */
export const REPLY = { input: 20_000, cached: 16_000, output: 1_000 };

/**
 * A `typicalMessage` resource: what one message of a person's takes of each of
 * the app's agents, on average, measured from what they really did: how many
 * calls (`calls`: 4.05 for the agent who answers, 0.6 for one asked now and
 * then), and each call's tokens: `input` (with what's read from the cache),
 * `cached`, `cacheWrite` and `output`. An agent it doesn't name isn't counted.
 */
export type TypicalMessage = Record<
  string,
  { calls: number; input: number; cached?: number; cacheWrite?: number; output: number }
>;

/**
 * A `planCredits` resource: the Action saying what credits the org's plan
 * gives (credits' `billing.credits`), `{}` in, `PlanCredits` or null out.
 */
export type PlanCredits = { action: string };

/** What the org's plan gives in credits: once (a trial's), or each month, for the org or a seat. */
export type CreditsShown = {
  /** The plan's name and title: `free`, "Free". */
  plan: string;
  title: string;
  /** USD. */
  amount: number;
  every: "once" | "month";
  perSeat?: true;
};

/** A model as a page shows it: its name, effort, a typical message's part, and what's tried after it. */
export type ModelShown = {
  id: string;
  name: string;
  effort?: string;
  /** USD, at this org's prices; null when nothing prices it. */
  price: number | null;
  /** It runs on the org's own key: its provider charges for it, not the app. */
  ownKey?: true;
  /** What's tried after it when it fails, in order. */
  fallbacks?: { id: string; name: string; effort?: string }[];
  /**
   * The plan of the person looking that answers it first, as their turns
   * try it (`"h-chatgpt/gpt-6.2-sol"`): it costs them nothing. `price` stays
   * what it costs on the app's models.
   */
  plan?: string;
};

export type TierShown = {
  name: string;
  title: string;
  description?: string;
  /** A typical message (its kinds' sum), or reply (their average), in USD; null when none is priced. */
  price: number | null;
  /**
   * The same for the person looking, with their plans (0 when plans answer
   * every kind): only when a plan of theirs answers some kind here.
   */
  yours?: number | null;
  /** The app's (as it is, or `changed` by the org), or one the org `made`. */
  app?: true;
  changed?: true;
  made?: true;
  /** Each kind of work's chain here, in the kinds' order. */
  kinds: { kind: string; model: ModelShown }[];
};

/** A kind of work: its title, and the app's agents that do it. */
export type KindShown = {
  kind: string;
  title: string;
  description?: string;
  /** For one the org added: the app's kind it starts from. */
  base?: string;
  agents: { agent: string; name: string; icon?: string }[];
};

export type Shown = {
  tiers: TierShown[];
  kinds: KindShown[];
  /** The app's tiers the org took away, to put back. */
  removed: { name: string; title: string }[];
  /** The tier the org's plan gives, when the app has plans that say. */
  plan: string | null;
  org: { tier: string | null; cap: string | null };
  space?: { tier: string | null };
  thread?: { tier: string | null };
  /** The person's own default for new chats. */
  person: { tier: string | null };
  /** What applies where it was asked: the tier in force and who chose it. */
  now: { tier: string; by: By } | null;
  /** What prices are for: a typical message the app measured, else a plain reply. */
  per: "message" | "reply";
  reply: typeof REPLY;
  /** What the org's plan gives in credits, when the app has plans that say. */
  credits: CreditsShown | null;
};

/** One agent where it works: its kind, the tier in force there, and its chain in it. */
export type AgentNow = {
  kind: string;
  kindTitle: string;
  tier: string;
  tierTitle: string;
  by: By;
  model: ModelShown;
};

/** The org's tiers and kinds, as it keeps them. */
export async function orgTiersOf(ctx: ReadContext) {
  const [templates, kinds] = await Promise.all([
    ctx.db.collection<Template>("tierTemplate").find({}),
    ctx.db.collection<OrgKind>("tierKind").find({}),
  ]);
  return { tiers: tiersIn(ctx, templates), kinds: kindsIn(ctx, kinds), templates };
}

const choices = (ctx: ReadContext) => ctx.db.collection<Choice>("modelChoice");

/** The org's plan's tier, through the `planTier` resource when something declares it. */
async function planTierOf(ctx: ReadContext): Promise<string | null> {
  const source = ctx.resources.planTier as { action?: string } | undefined;
  return source?.action ? await ctx.call<string | null>(source.action, {}) : null;
}

/** What each level chose, where asked: the conversation, the person, the space, the org, the plan. */
export async function levelsOf(
  ctx: ReadContext,
  where: { space?: string; thread?: string; person?: string },
): Promise<Levels> {
  const one = (id?: string) => id ? choices(ctx).findOne({ _id: id }) : Promise.resolve(null);
  const [thread, person, space, org, plan] = await Promise.all([
    one(where.thread && threadChoice(where.thread)),
    one(where.person && personChoice(where.person)),
    one(where.space && spaceChoice(where.space)),
    one(ORG_CHOICE),
    planTierOf(ctx),
  ]);
  return { thread, person, space, org, plan };
}

/** The app's measured message, when it has one. */
const typicalOf = (ctx: ReadContext): TypicalMessage | undefined => {
  const typical = ctx.resources.typicalMessage as TypicalMessage | undefined;
  return typical && Object.keys(typical).length ? typical : undefined;
};

/** What the org's plan gives in credits, through the `planCredits` resource when something declares it. */
async function creditsOf(ctx: ReadContext): Promise<CreditsShown | null> {
  const source = ctx.resources.planCredits as PlanCredits | undefined;
  if (!source?.action) return null;
  return await ctx.call<CreditsShown | null>(source.action, {}).catch(() => null);
}

/** A model for one of the app's agents: its price is that agent's part of a typical message. */
type Use = { ref: ModelRef; agent: string };

/** Each model a ref tries, in order, each as `primaryOf` reads one. */
const entriesOf = (ctx: ReadContext, ref: ModelRef) =>
  (Array.isArray(ref) ? ref : [ref]).flatMap((entry) => {
    const found = primaryOf(ctx, entry);
    return found ? [found] : [];
  });

/**
 * For each use, the plan of the person's (`theirs`) its chain would run on
 * first, as their turns try it (`models.check`), when it's a plan; each
 * chain asked once.
 */
async function planFirsts(ctx: ReadContext, uses: Use[], theirs: Plans) {
  const asked = new Map<string, Promise<string | undefined>>();
  const firstOf = (ref: ModelRef) => {
    const key = JSON.stringify(ref);
    let found = asked.get(key);
    if (!found) {
      found = ctx.call<string[]>("models.check", { model: { model: ref, ...theirs }, port: "llm" })
        .then((tried) => tried[0], () => undefined);
      asked.set(key, found);
    }
    return found;
  };
  const firsts = await Promise.all(uses.map((use) => firstOf(use.ref)));
  return firsts.map((id) =>
    id && theirs.harnesses.includes(id.slice(0, id.indexOf("/"))) ? id : undefined
  );
}

/**
 * Names and prices for models, by `"provider/model"` and effort, each asked
 * once: a typical message's part for the agent (its calls, each call's
 * tokens), else a plain reply. A model is named by the first it tries, and
 * priced at the first the app charges something for: one on the org's own key
 * or free here (a person's ChatGPT plan) is passed over for the next, as a
 * turn is when the person hasn't connected that plan; a list all on the org's
 * own keys isn't priced.
 */
async function modelsShown(
  ctx: ReadContext,
  uses: Use[],
  theirs: Plans = { harnesses: [] },
): Promise<(ModelShown | undefined)[]> {
  const typical = typicalOf(ctx);
  const lists = uses.map((use) => entriesOf(ctx, use.ref));
  const firsts = theirs.harnesses.length ? planFirsts(ctx, uses, theirs) : undefined;
  const ids = [...new Set(lists.flat().map((entry) => entry.id))];
  const offered = await Promise.all(
    ids.map((model) =>
      ctx.call<{ model: OfferedModel | null }>("models.offered", { model })
        .then((answer) => answer.model, () => null)
    ),
  );
  const known = new Map(ids.map((id, i) => [id, offered[i]]));
  const declared = (ctx.resources.provider ?? {}) as Record<string, Provider>;
  // What one call is charged: each agent's (a plain reply's, without a measured message).
  const callOf = (agent: string) => {
    const measured = typical?.[agent];
    if (!typical) return REPLY;
    if (!measured) return undefined;
    const { calls: _, ...tokens } = measured;
    return tokens;
  };
  const keyOf = (id: string, agent: string) => typical ? `${id} ${agent}` : id;
  // Every model each tries that's on the app's keys, when there's a ledger, each call asked once.
  const charged = lists.map((list) =>
    ctx.resources.usage ? list.filter((entry) => !known.get(entry.id)?.ownKey) : []
  );
  const asked = new Map<string, { id: string; agent: string }>();
  charged.forEach((list, i) => {
    if (!callOf(uses[i].agent)) return;
    for (const entry of list) {
      asked.set(keyOf(entry.id, uses[i].agent), { id: entry.id, agent: uses[i].agent });
    }
  });
  const quotes = [...asked.values()];
  const quoted = quotes.length
    ? await ctx.call<(number | null)[]>("usage.quotes", {
      uses: quotes.map(({ id, agent }) => {
        const slash = id.indexOf("/");
        const from = declared[id.slice(0, slash)]?.catalog;
        return {
          meter: "llm",
          subject: id,
          catalog: `${typeof from === "string" ? from : id.slice(0, slash)}${id.slice(slash)}`,
          quantities: callOf(agent)!,
        };
      }),
    }).catch(() => quotes.map(() => null))
    : [];
  const prices = new Map([...asked.keys()].map((key, i) => [key, quoted[i] ?? null]));
  const plans = await firsts;
  return lists.map((list, i) => {
    const p = list[0];
    if (!p) return undefined;
    const info = known.get(p.id);
    const agent = uses[i].agent;
    // The first that costs something: one that's free here is a plan the person brings.
    const each = charged[i].map((entry) => prices.get(keyOf(entry.id, agent)) ?? null);
    const call = each.find((price) => price !== null && price > 0) ??
      each.find((price) => price !== null) ?? null;
    const calls = typical ? typical[agent]?.calls ?? 0 : 1;
    const named = (id: string) => known.get(id)?.name ?? id.slice(id.indexOf("/") + 1);
    return {
      id: p.id,
      name: named(p.id),
      ...(p.effort ? { effort: p.effort } : {}),
      price: call === null ? null : call * calls,
      ...(info?.ownKey && !charged[i].length ? { ownKey: true as const } : {}),
      ...(plans?.[i] ? { plan: plans[i] } : {}),
      ...(list.length > 1
        ? {
          fallbacks: list.slice(1).map((entry) => ({
            id: entry.id,
            name: named(entry.id),
            ...(entry.effort ? { effort: entry.effort } : {}),
          })),
        }
        : {}),
    };
  });
}

/** What's priced, summed (a message) or averaged (a reply); null when nothing is. */
const total = (prices: (number | null)[], per: "message" | "reply") => {
  const priced = prices.filter((p): p is number => p !== null);
  if (!priced.length) return null;
  const sum = priced.reduce((a, b) => a + b, 0);
  return per === "message" ? sum : sum / priced.length;
};

/** Everything a page shows, at the org's level, or where asked (a space, a conversation). */
export async function shownAt(
  ctx: ReadContext,
  where: { space?: string; thread?: string } = {},
): Promise<Shown> {
  const person = personOf(ctx.actor);
  const [{ tiers, kinds, templates }, levels, credits] = await Promise.all([
    orgTiersOf(ctx),
    levelsOf(ctx, { ...where, ...(person ? { person } : {}) }),
    creditsOf(ctx),
  ]);
  const per = typicalOf(ctx) ? "message" : "reply";
  const agents = agentsOf(ctx);
  const kindNames = Object.keys(kinds);
  const list = Object.entries(tiers);
  // Every tier's chain for every kind, asked for at once, and taken back in the same order.
  const uses = list.flatMap(([, tier]) =>
    kindNames.flatMap((kind) => {
      const ref = entryOf(tier, kind, kinds);
      return ref === undefined ? [] : [{ ref, agent: kinds[kind].base ?? kind }];
    })
  );
  // The person's plans they can run now, in their order: what their turns go with.
  const theirs = person ? await plansFor(ctx, levels.person?.harnesses) : { harnesses: [] };
  const shown = await modelsShown(ctx, uses, theirs);
  let cursor = 0;
  const tiersShown: TierShown[] = list.map(([name, tier]) => {
    const own = kindNames.flatMap((kind) =>
      entryOf(tier, kind, kinds) === undefined ? [] : [{ kind, model: shown[cursor++] }]
    ).filter((k): k is { kind: string; model: ModelShown } => !!k.model);
    // Only the app's kinds count toward a typical message: an org's own is extra.
    const counted = own.filter((k) => !kinds[k.kind].base);
    return {
      name,
      title: tier.title,
      ...(tier.description ? { description: tier.description } : {}),
      price: total(counted.map((k) => k.model.price), per),
      // On a plan of theirs, a kind costs them nothing.
      ...(counted.some((k) => k.model.plan)
        ? { yours: total(counted.map((k) => k.model.plan ? 0 : k.model.price), per) }
        : {}),
      ...(tier.app ? { app: true as const } : {}),
      ...(tier.changed ? { changed: true as const } : {}),
      ...(tier.made ? { made: true as const } : {}),
      kinds: own,
    };
  });
  const offered = (name?: string | null) => name && tiers[name] ? name : null;
  const app = (ctx.resources.tiers ?? {}) as Record<string, OrgTier>;
  const inForce = tierIn(tiers, levels);
  return {
    tiers: tiersShown,
    kinds: kindNames.map((kind) => ({
      kind,
      title: kinds[kind].title,
      ...(kinds[kind].description ? { description: kinds[kind].description } : {}),
      ...(kinds[kind].base ? { base: kinds[kind].base } : {}),
      agents: Object.entries(agents)
        .filter(([name, def]) =>
          kindOf(ctx, name, def.like, kinds) === kind && agents[name].default
        )
        .map(([name, def]) => ({
          agent: name,
          name: def.name ?? name[0].toUpperCase() + name.slice(1),
          ...(def.icon ? { icon: def.icon } : {}),
        })),
    })),
    removed: templates.filter((t) => t.off && app[t._id])
      .map((t) => ({ name: t._id, title: app[t._id].title })),
    plan: offered(levels.plan),
    org: { tier: offered(levels.org?.tier), cap: offered(levels.org?.cap) },
    ...(where.space ? { space: { tier: offered(levels.space?.tier) } } : {}),
    ...(where.thread ? { thread: { tier: offered(levels.thread?.tier) } } : {}),
    person: { tier: offered(levels.person?.tier) },
    now: inForce ?? null,
    per,
    reply: REPLY,
    credits,
  };
}

/** Which of the app's kinds one people made works as, as chat's `agentSources` say. */
async function likeOf(ctx: ReadContext, agent: string): Promise<string | undefined> {
  const sources = Object.values(
    (ctx.resources.agentSources ?? {}) as Record<string, { action: string }>,
  );
  for (const source of sources) {
    const told = await ctx.call<Record<string, { like?: string }>>(source.action, {
      names: [agent],
    })
      .catch(() => ({} as Record<string, { like?: string }>));
    if (told[agent]) return told[agent].like;
  }
  return undefined;
}

/**
 * One agent where it works (a space, maybe a conversation): its kind of work,
 * the tier in force there and who chose it, and its chain in that tier; null
 * when no tier applies.
 */
export async function agentAt(
  ctx: ReadContext,
  agent: string,
  where: { space?: string; thread?: string },
): Promise<AgentNow | null> {
  const person = personOf(ctx.actor);
  const [{ tiers, kinds }, levels] = await Promise.all([
    orgTiersOf(ctx),
    levelsOf(ctx, { ...where, ...(person ? { person } : {}) }),
  ]);
  const declared = agentsOf(ctx)[agent];
  const like = declared ? declared.like : await likeOf(ctx, agent);
  const kind = kindOf(ctx, agent, like, kinds);
  const inForce = tierIn(tiers, levels);
  if (!kind || !inForce) return null;
  const ref = entryOf(tiers[inForce.tier], kind, kinds);
  if (ref === undefined) return null;
  const [model] = await modelsShown(ctx, [{ ref, agent: kinds[kind].base ?? kind }]);
  if (!model) return null;
  return {
    kind,
    kindTitle: kinds[kind].title,
    tier: inForce.tier,
    tierTitle: tiers[inForce.tier].title,
    by: inForce.by,
    model,
  };
}
