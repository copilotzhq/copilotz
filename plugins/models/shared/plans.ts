/**
 * Plans first: a model list run on a person's plans before any API. A plan
 * is a provider with `harness` (Claude Code's `claude-plan`, ChatGPT's
 * `chatgpt`): what it serves, by the models' API ids, and its own name for
 * each. Given the person's plans in their order (the `harnesses` setting),
 * a list becomes:
 *
 * - each model it names, once, in its order: an API entry is its own model;
 *   one naming a plan (`claude-plan/…`) stands for the model that plan serves,
 *   on plans only;
 * - first, for each model, every plan of theirs that serves it, in their
 *   order, with the entry's settings (not its `options`, another protocol's)
 *   and the model's catalog entry;
 * - then the list's API entries, as listed.
 *
 * Left with nothing (it named only plans they don't have), it's the list as
 * written, whose plans say what to do.
 */
import type { Provider } from "./choice.ts";

/** One model of a list, with its settings. */
type Choice = { id: string; settings: Record<string, unknown> };

const providerOf = (id: string) => id.slice(0, id.indexOf("/"));
const nameOf = (id: string) => id.slice(id.indexOf("/") + 1);

/** A plan's own name for a model (`"anthropic/claude-opus-5-5"`); undefined when it doesn't serve it. */
function servedAs(plan: string, provider: Provider | undefined, model: string) {
  if (providerOf(model) === plan) return nameOf(model);
  const serves = provider?.harness?.serves ?? {};
  const named = serves[model] ?? serves[`${providerOf(model)}/*`];
  return named === undefined ? undefined : named === "*" ? nameOf(model) : named;
}

/** The model a plan's entry stands for, by its API id: its own when its plan names it nowhere. */
function modelOf(plan: string, provider: Provider, id: string) {
  const name = nameOf(id);
  const serves = Object.entries(provider.harness?.serves ?? {});
  const named = serves.find(([model, as]) =>
    !model.endsWith("/*") && (as === name || (as === "*" && nameOf(model) === name))
  );
  if (named) return named[0];
  const all = serves.find(([model]) => model.endsWith("/*"));
  return all ? `${providerOf(all[0])}/${name}` : `${plan}/${name}`;
}

/** `found` (a list's models, in order) on `harnesses` first: see above. */
export function plansFirst(
  providers: Record<string, Provider | undefined>,
  found: Choice[],
  harnesses: string[],
): Choice[] {
  const plans = harnesses.filter((name) => providers[name]?.harness);
  const named = found.map((choice) => {
    const plan = providers[providerOf(choice.id)]?.harness ? providerOf(choice.id) : undefined;
    return {
      ...choice,
      model: plan ? modelOf(plan, providers[plan]!, choice.id) : choice.id,
      plan,
    };
  });
  const seen = new Set<string>();
  const first: Choice[] = [];
  for (const { model, settings } of named) {
    if (seen.has(model)) continue;
    seen.add(model);
    const { options: _, catalog: __, ...kept } = settings;
    // The model's catalog entry, when it's an API's: its efforts, limits and prices.
    const known = providers[providerOf(model)]?.harness ? {} : { catalog: model };
    for (const plan of plans) {
      const as = servedAs(plan, providers[plan], model);
      if (as !== undefined) first.push({ id: `${plan}/${as}`, settings: { ...kept, ...known } });
    }
  }
  const apis = named.filter((choice) => !choice.plan).map(({ id, settings }) => ({ id, settings }));
  const out = [...first, ...apis];
  return out.length ? out : found;
}
