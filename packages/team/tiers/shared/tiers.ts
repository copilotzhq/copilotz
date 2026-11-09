/**
 * Tiers, and which model each of the app's agents thinks with: the app's
 * tiers (its `tiers` resource), what an org and a space chose (`modelChoice`),
 * and what the org's plan gives, worked out the same way for a turn and for a
 * page. Only plain data in and out: no reads here.
 */
import type { Resources } from "copilotz";
import type { ModelRef } from "copilotz/plugins/models/contract";
import { agentsOf, modelOf } from "copilotz/plugins/agents/contract";

/** A tier: a model for each of the app's agents, named by what it's good for. */
export type Tier = {
  title: string;
  /** What it's good for, in a line: "Quick answers, routine work, volume". */
  description?: string;
  /** Among the tiers, lowest first. */
  order?: number;
  /** Each agent's model, as an agent's `model` takes it: one, settings around one, or a list. */
  agents: Record<string, ModelRef>;
};

/** What an org or a space chose: a tier by its name, and models picked for some agents. Unset: theirs above. */
export type Choice = { tier?: string; custom?: Record<string, ModelRef> };

/** Where a choice is kept: the org's, or a space's. */
export const ORG_CHOICE = "org";
export const spaceChoice = (space: string): string => `space:${space}`;

/** The app's tiers. */
export const tiersOf = (ctx: { resources: Resources }): Record<string, Tier> =>
  (ctx.resources.tiers ?? {}) as Record<string, Tier>;

/** Where a model comes from: picked here, a tier chosen here, the plan's tier, or the agent's own. */
export type From =
  | { by: "space" | "org"; custom: true; tier?: string }
  | { by: "space" | "org" | "plan"; tier: string }
  | { by: "app" };

/** What applies, at one level and those above it: each a choice, or none. */
export type Levels = { space?: Choice | null; org?: Choice | null; plan?: string | null };

/** A tier that's still offered: one that's gone counts as none chosen. */
const offered = (tiers: Record<string, Tier>, name?: string | null) =>
  name && Object.hasOwn(tiers, name) ? name : undefined;

/** The tier in force: the space's, else the org's, else the plan's; and who chose it. */
export function tierIn(
  tiers: Record<string, Tier>,
  levels: Levels,
): { tier: string; by: "space" | "org" | "plan" } | undefined {
  const space = offered(tiers, levels.space?.tier);
  if (space) return { tier: space, by: "space" };
  const org = offered(tiers, levels.org?.tier);
  if (org) return { tier: org, by: "org" };
  const plan = offered(tiers, levels.plan);
  return plan ? { tier: plan, by: "plan" } : undefined;
}

/** A model, as a list: what's tried in order. */
const listOf = (ref: ModelRef): ModelRef[] => Array.isArray(ref) ? ref : [ref];

/** The model a ref tries first, as `"provider/model"` when it says so plainly. */
const firstId = (ref: ModelRef): string | undefined => {
  const first = listOf(ref)[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && !Array.isArray(first)) {
    return typeof first.model === "string" ? first.model : firstId(first.model);
  }
  return undefined;
};

/** What `resolve` says: the model, where it comes from, and for a pick, what it stands in front of. */
export type Resolved = {
  model: ModelRef | null;
  from: From;
  /** A pick: itself, the entry it replaces (whose settings carry over), and the list behind it. */
  pick?: { ref: ModelRef; replaces: ModelRef; behind: ModelRef[] };
};

/**
 * Which model one of the app's agents thinks with, and where it comes from,
 * the first that applies: the space's pick for it, the space's tier, the
 * org's pick, the org's tier, the plan's tier. A tier that doesn't name the
 * agent leaves it on its own model; so does nothing chosen (`model` null).
 * A pick keeps the list it stands in front of behind it (the tier in force
 * below it, or the agent's own), so a model that fails falls back as before;
 * `carried` gives it that entry's settings. An agent that isn't the app's is
 * none of this: null.
 */
export function resolve(
  ctx: { resources: Resources },
  agent: string,
  levels: Levels,
): Resolved {
  const tiers = tiersOf(ctx);
  const own = agentsOf(ctx)[agent];
  if (!own) return { model: null, from: { by: "app" } };
  const below = (from: "space" | "org") => {
    const rest = from === "space" ? levels : { ...levels, space: null };
    const tier = tierIn(tiers, rest);
    return tier && Object.hasOwn(tiers[tier.tier].agents, agent)
      ? { list: tiers[tier.tier].agents[agent], tier: tier.tier }
      : { list: modelOf(own) as ModelRef };
  };
  for (const by of ["space", "org"] as const) {
    const choice = levels[by];
    const pick = choice?.custom?.[agent];
    if (pick !== undefined) {
      const { list, tier } = below(by);
      const picked = firstId(pick);
      const behind = listOf(list).filter((ref) => !picked || firstId(ref) !== picked);
      return {
        model: [...listOf(pick), ...behind],
        from: { by, custom: true, ...(tier ? { tier } : {}) },
        pick: { ref: pick, replaces: listOf(list)[0], behind },
      };
    }
    const tier = offered(tiers, choice?.tier);
    if (tier) {
      return Object.hasOwn(tiers[tier].agents, agent)
        ? { model: tiers[tier].agents[agent], from: { by, tier } }
        : { model: null, from: { by: "app" } };
    }
  }
  const plan = offered(tiers, levels.plan);
  if (plan && Object.hasOwn(tiers[plan].agents, agent)) {
    return { model: tiers[plan].agents[agent], from: { by: "plan", tier: plan } };
  }
  return { model: null, from: { by: "app" } };
}

/** What a model's first choice is set to think and write with. */
type Settings = { effort?: string; maxTokens?: number };

/**
 * The model a ref tries first, with the effort and most tokens it's asked
 * for, following aliases (`resources.model`): what a page shows of it, and
 * what a pick carries over.
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
 * The model `resolve` found, a pick given what the entry it replaces sets:
 * its `maxTokens`, and its `effort` when the picked model takes that level
 * (the catalog's, `models.efforts`), else none, so a pick isn't cut short by
 * an adapter's default nor refused for an effort it doesn't have. What the
 * pick sets itself wins.
 */
export async function carried(
  ctx: { resources: Resources; call<R>(action: string, input?: unknown): Promise<R> },
  resolved: Resolved,
): Promise<ModelRef | null> {
  if (!resolved.pick) return resolved.model;
  const { ref, replaces, behind } = resolved.pick;
  const from = primaryOf(ctx, replaces);
  const picked = primaryOf(ctx, ref);
  const levels = from?.effort && picked
    ? await ctx.call<string[] | null>("models.efforts", { model: picked.id }).catch(() => null)
    : null;
  const settings = {
    ...(from?.maxTokens !== undefined ? { maxTokens: from.maxTokens } : {}),
    ...(from?.effort && levels?.includes(from.effort) ? { effort: from.effort } : {}),
  };
  if (!Object.keys(settings).length) return resolved.model;
  const [first, ...rest] = listOf(ref);
  return [{ model: first, ...settings }, ...rest, ...behind];
}
