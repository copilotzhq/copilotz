/**
 * Tiers as templates, worked out the same way for a turn and for a page. Only
 * plain data in and out: no reads here.
 *
 * - **A kind of work** (`north`, as the app calls it, titled "Decides") is
 *   what an agent does, as far as its model goes. The app's kinds are its
 *   tiers' keys, titled by its `tierKinds` resource; an org adds its own,
 *   each based on one of the app's (`tierKind`). Every agent has one: one of
 *   the app's agents is its own kind when the tiers name it; any other says
 *   which (`like`), else it's the app's first.
 * - **A tier** is a template: for each kind of work, a model chain (as an
 *   agent's `model` takes one: a model, settings around one, or a list tried
 *   in order). The app declares its tiers (`tiers`); an org keeps its own
 *   version of one (`tierTemplate`: kinds' chains changed, or `off`, taken
 *   away) and makes new ones (`made`). A kind a tier doesn't name takes its
 *   base kind's chain there.
 * - **Which tier a turn uses**, the first that applies: the conversation's,
 *   the person's own default for new chats, the space's, the org's, the
 *   plan's (`modelChoice`).
 */
import type { Resources } from "copilotz";
import type { ModelRef } from "copilotz/plugins/models/contract";
import { agentsOf, defaults } from "copilotz/plugins/agents/contract";

/** A tier: a model chain for each kind of work, named by what it's good for. */
export type Tier = {
  title: string;
  /** What it's good for, in a line: "Quick answers, routine work, volume". */
  description?: string;
  /** Among the tiers, lowest first. */
  order?: number;
  /** Each kind of work's chain, by kind, as an agent's `model` takes it. */
  agents: Record<string, ModelRef>;
};

/** A tier as the org has it: the app's (as it is, or `changed`), or one the org `made`. */
export type OrgTier = Tier & { app?: true; changed?: true; made?: true };

/** What an org keeps of a tier: its version of the app's (or that it took it away), or one it made. */
export type Template = {
  _id: string;
  title?: string;
  description?: string;
  order?: number;
  agents?: Record<string, ModelRef>;
  /** One of the app's the org took away. */
  off?: boolean;
  /** One the org made. */
  made?: boolean;
  at: string;
};

/** A kind of work: what it's called, and for one an org added, the app's kind it starts from. */
export type Kind = { title: string; description?: string; base?: string };

/** One an org added (`tierKind`), by its name. */
export type OrgKind = {
  _id: string;
  title: string;
  description?: string;
  base: string;
  at: string;
};

/**
 * What a level chose: a tier by its name; the org's also the highest tier its
 * members may use; a person's also the order of their plans (`harnesses`).
 */
export type Choice = { tier?: string; cap?: string; harnesses?: string[] };

/** Where a choice is kept. */
export const ORG_CHOICE = "org";
export const spaceChoice = (space: string): string => `space:${space}`;
export const threadChoice = (thread: string): string => `thread:${thread}`;
export const personChoice = (person: string): string => `person:${person}`;

/** Who chose the tier in force. */
export type By = "thread" | "person" | "space" | "org" | "plan";

/** What applies, at each level: each a choice, or none. */
export type Levels = {
  thread?: Choice | null;
  person?: Choice | null;
  space?: Choice | null;
  org?: Choice | null;
  plan?: string | null;
};

/** The app's tiers, as it declares them. */
export const appTiersOf = (ctx: { resources: Resources }): Record<string, Tier> =>
  (ctx.resources.tiers ?? {}) as Record<string, Tier>;

/** The app's kinds of work: its tiers' keys, in the order its agents are declared, titled. */
export function appKindsOf(ctx: { resources: Resources }): Record<string, Kind> {
  const named = (ctx.resources.tierKinds ?? {}) as Record<string, Kind | null>;
  const agents = agentsOf(ctx);
  const keys = new Set(
    Object.values(appTiersOf(ctx)).flatMap((t) => Object.keys(t.agents ?? {})),
  );
  const order = [
    ...Object.keys(agents).filter((a) => keys.has(a)),
    ...[...keys].filter((k) => !agents[k]),
  ];
  return Object.fromEntries(order.map((key) => [key, {
    title: named[key]?.title ?? agents[key]?.name ?? key[0].toUpperCase() + key.slice(1),
    ...(named[key]?.description ? { description: named[key]!.description } : {}),
  }]));
}

/** Every kind of work: the app's, then those the org added (on an app's kind still there). */
export function kindsIn(ctx: { resources: Resources }, own: OrgKind[]): Record<string, Kind> {
  const app = appKindsOf(ctx);
  const added = own.filter((k) => !app[k._id] && app[k.base])
    .sort((a, b) => a.at.localeCompare(b.at) || a._id.localeCompare(b._id));
  return {
    ...app,
    ...Object.fromEntries(added.map((k) => [k._id, {
      title: k.title,
      ...(k.description ? { description: k.description } : {}),
      base: k.base,
    }])),
  };
}

/** The kind an agent works as: what it says (`like`); its own, where tiers name it; else the app's first. */
export function kindOf(
  ctx: { resources: Resources },
  name: string,
  like: string | undefined,
  kinds: Record<string, Kind>,
): string | undefined {
  if (like && kinds[like]) return like;
  if (kinds[name]) return name;
  const agents = agentsOf(ctx);
  return defaults(agents).find((a) => kinds[a]) ?? Object.keys(kinds)[0];
}

/**
 * The org's tiers: the app's as the org keeps them (its version over them,
 * those it took away left out), then those it made; each by its name, in
 * order.
 */
export function tiersIn(
  ctx: { resources: Resources },
  templates: Template[],
): Record<string, OrgTier> {
  const app = appTiersOf(ctx);
  const kept = new Map(templates.map((t) => [t._id, t]));
  const out: [string, OrgTier][] = [];
  for (const [name, tier] of Object.entries(app)) {
    const mine = kept.get(name);
    if (mine?.off) continue;
    const changed = !!mine && (Object.keys(mine.agents ?? {}).length > 0 ||
      mine.title !== undefined || mine.description !== undefined);
    out.push([name, {
      ...tier,
      ...(mine?.title ? { title: mine.title } : {}),
      ...(mine?.description !== undefined ? { description: mine.description } : {}),
      agents: { ...tier.agents, ...mine?.agents },
      app: true,
      ...(changed ? { changed: true } : {}),
    }]);
  }
  for (const mine of templates) {
    if (!mine.made || app[mine._id] || mine.off) continue;
    out.push([mine._id, {
      title: mine.title ?? mine._id,
      ...(mine.description ? { description: mine.description } : {}),
      order: mine.order ?? 1000,
      agents: { ...mine.agents },
      made: true,
    }]);
  }
  return Object.fromEntries(
    out.sort(([a, x], [b, y]) => (x.order ?? 0) - (y.order ?? 0) || a.localeCompare(b)),
  );
}

/** A kind's chain in a tier: its own entry there, else its base kind's. */
export function entryOf(
  tier: Tier | undefined,
  kind: string | undefined,
  kinds: Record<string, Kind>,
): ModelRef | undefined {
  if (!tier || !kind) return undefined;
  if (tier.agents[kind] !== undefined) return tier.agents[kind];
  const base = kinds[kind]?.base;
  return base && tier.agents[base] !== undefined ? tier.agents[base] : undefined;
}

/** A tier that's still offered: one that's gone counts as none chosen. */
const offered = (tiers: Record<string, unknown>, name?: string | null) =>
  name && Object.hasOwn(tiers, name) ? name : undefined;

/** The tier in force, and who chose it: the conversation, the person, the space, the org, the plan. */
export function tierIn(
  tiers: Record<string, unknown>,
  levels: Levels,
): { tier: string; by: By } | undefined {
  for (const by of ["thread", "person", "space", "org"] as const) {
    const tier = offered(tiers, levels[by]?.tier);
    if (tier) return { tier, by };
  }
  const plan = offered(tiers, levels.plan) ?? Object.keys(tiers)[0];
  return plan ? { tier: plan, by: "plan" } : undefined;
}

/** Whether a tier is above the highest the org lets its members use (`cap`). */
export function aboveCap(tiers: Record<string, unknown>, tier: string, cap?: string): boolean {
  if (!cap || !Object.hasOwn(tiers, cap) || !Object.hasOwn(tiers, tier)) return false;
  const names = Object.keys(tiers);
  return names.indexOf(tier) > names.indexOf(cap);
}

/** A model, as a list: what's tried in order. */
export const listOf = (ref: ModelRef): ModelRef[] => Array.isArray(ref) ? ref : [ref];

/** The model a ref tries first, as `"provider/model"` when it says so plainly. */
export const firstId = (ref: ModelRef): string | undefined => {
  const first = listOf(ref)[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && !Array.isArray(first)) {
    return typeof first.model === "string" ? first.model : firstId(first.model);
  }
  return undefined;
};

/** What a model's first choice is set to think and write with. */
export type Settings = { effort?: string; maxTokens?: number };

/**
 * The model a ref tries first, with the effort and most tokens it's asked
 * for, following aliases (`resources.model`): what a page shows of it.
 */
export function primaryOf(
  ctx: { resources: Resources },
  ref: ModelRef,
  outer: Settings = {},
  seen: string[] = [],
): ({ id: string } & Settings) | undefined {
  if (Array.isArray(ref)) return ref.length ? primaryOf(ctx, ref[0], outer, seen) : undefined;
  if (typeof ref === "string") {
    if (ref.includes("/")) return { id: ref, ...outer };
    const alias = (ctx.resources.model ?? {})[ref] as ModelRef | undefined;
    if (alias === undefined || seen.includes(ref)) return undefined;
    // An alias holds defaults: what's set where it's used wins.
    const found = primaryOf(ctx, alias, {}, [...seen, ref]);
    return found && { ...found, ...outer };
  }
  // Settings next to a model are over those around it.
  return primaryOf(ctx, ref.model, {
    ...outer,
    ...(typeof ref.effort === "string" ? { effort: ref.effort } : {}),
    ...(typeof ref.maxTokens === "number" ? { maxTokens: ref.maxTokens } : {}),
  }, seen);
}

/**
 * A chain someone set on a page (each entry a model), with what the chain it
 * replaces sets on its first entry: its `maxTokens`, and its `effort` where
 * each model takes it and none was said (the catalog's, `models.efforts`).
 * So a chain set by hand isn't cut short by an adapter's default.
 */
export async function settled(
  ctx: { resources: Resources; call<R>(action: string, input?: unknown): Promise<R> },
  chain: ModelRef[],
  like: ModelRef | undefined,
): Promise<ModelRef[]> {
  const from = like ? primaryOf(ctx, like) : undefined;
  return await Promise.all(chain.map(async (entry) => {
    const picked = primaryOf(ctx, entry);
    if (!picked || !from) return entry;
    const levels = from.effort && !picked.effort
      ? await ctx.call<string[] | null>("models.efforts", { model: picked.id }).catch(() => null)
      : null;
    const settings = {
      ...(from.maxTokens !== undefined && picked.maxTokens === undefined
        ? { maxTokens: from.maxTokens }
        : {}),
      ...(from.effort && levels?.includes(from.effort) ? { effort: from.effort } : {}),
    };
    return Object.keys(settings).length ? { model: entry, ...settings } as ModelRef : entry;
  }));
}
