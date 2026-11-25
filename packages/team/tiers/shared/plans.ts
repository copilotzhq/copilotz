/**
 * A person's plans, as tiers run them: the app's (providers with `harness`,
 * the models plugin's), in the person's order (`harnesses` on their
 * `person:<id>` choice: theirs first, then the rest in the app's), and
 * those they've connected now (each `connectedPlans` source, asked as them
 * on every turn, never kept here). A turn's chain goes with them
 * (`{ model, harnesses }`), and the models plugin runs each model on them
 * first. What a chain would try, in order, is `models.check`'s answer.
 */
import { personOf, type ReadContext, type Resources } from "copilotz";
import type { ConnectedPlans, Provider } from "copilotz/plugins/models/contract";
import { orgTiersOf } from "./shown.ts";
import { type Choice, personChoice } from "./tiers.ts";

/** One of the app's plans, as a person orders them. */
export type HarnessShown = {
  /** Its provider: `claude-plan`. */
  name: string;
  /** What people call it: "Claude plan". */
  title: string;
  /** The plan it runs on ("ChatGPT"): two ways to run one plan show as one. */
  plan: string;
  /** The person has it now: their account, or signed in on a computer of theirs. */
  connected: boolean;
};

/** The app's plans, by provider name. */
export function harnessesOf(ctx: { resources: Resources }): Record<string, Provider> {
  const declared = (ctx.resources.provider ?? {}) as Record<string, Provider | null>;
  return Object.fromEntries(
    Object.entries(declared).filter((entry): entry is [string, Provider] => !!entry[1]?.harness),
  );
}

/** The app's plans in a person's order: theirs first (`mine`), then the rest, lowest `order` first. */
export function orderOf(ctx: { resources: Resources }, mine: string[] = []): string[] {
  const plans = harnessesOf(ctx);
  const byDefault = Object.keys(plans).sort((a, b) =>
    plans[a].harness!.order - plans[b].harness!.order || a.localeCompare(b)
  );
  const theirs = mine.filter((name, i) => plans[name] && mine.indexOf(name) === i);
  return [...theirs, ...byDefault.filter((name) => !theirs.includes(name))];
}

/** The plans the person a call is for has connected now, as each source says (as them). */
export async function connectedOf(ctx: Pick<ReadContext, "resources" | "call">) {
  const sources = Object.values(
    (ctx.resources.connectedPlans ?? {}) as Record<string, ConnectedPlans | null>,
  ).filter((source): source is ConnectedPlans => !!source?.action);
  const said = await Promise.all(
    sources.map((source) => ctx.call<string[]>(source.action, {}).catch(() => [] as string[])),
  );
  return new Set(said.flat());
}

/**
 * The plans the person a call is for can run now, in their order (`mine`:
 * their `harnesses`): what a model list goes with (`{ model, harnesses }`).
 */
export async function plansFor(
  ctx: Pick<ReadContext, "resources" | "call" | "actor">,
  mine?: string[],
): Promise<string[]> {
  if (!personOf(ctx.actor) || !Object.keys(harnessesOf(ctx)).length) return [];
  const connected = await connectedOf(ctx);
  return orderOf(ctx, mine).filter((name) => connected.has(name));
}

/**
 * The app's plans, as a person orders them: those that run a model some
 * tier of the org names (each chain, as it would be tried on every plan), in
 * their order, each with whether they've connected it now.
 */
export async function harnessesShown(ctx: ReadContext): Promise<HarnessShown[]> {
  const plans = harnessesOf(ctx);
  const person = personOf(ctx.actor);
  if (!person || !Object.keys(plans).length) return [];
  const all = Object.keys(plans);
  const [{ tiers }, mine, connected] = await Promise.all([
    orgTiersOf(ctx),
    ctx.db.collection<Choice>("modelChoice").findOne({ _id: personChoice(person) }),
    connectedOf(ctx),
  ]);
  const chains = Object.values(tiers).flatMap((tier) => Object.values(tier.agents));
  const tried = await Promise.all(
    chains.map((chain) =>
      ctx.call<string[]>("models.check", { model: { model: chain, harnesses: all }, port: "llm" })
        .catch(() => [] as string[])
    ),
  );
  const used = new Set(tried.flat().map((id) => id.slice(0, id.indexOf("/"))));
  return orderOf(ctx, mine?.harnesses).filter((name) => used.has(name)).map((name) => ({
    name,
    title: plans[name].title ?? name,
    plan: plans[name].harness!.plan,
    connected: connected.has(name),
  }));
}
