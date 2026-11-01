/**
 * `models.offered`: what a person can choose an agent's model from.
 *
 * - `{}`: every provider, those ready first: its id and name, how many models,
 *   whether it can be used now (`ready`), and whether a key can be brought for
 *   it, with the end of the org's if it has one (`hint`). `set`: whether the
 *   person asking may change keys.
 * - `{ provider }`: that provider's models an agent can work with, newest first.
 * - `{ search }`: providers and models whose words match.
 * - `{ model }`: one model, `"provider/model"`, to show what's chosen.
 *
 * Only what an agent can use is offered: it answers in text, calls tools, and
 * isn't deprecated. Nothing secret is in it. `models.keyable`: whether a key
 * can be brought for a provider.
 */
import { type Context, defineAction, people } from "../../../runtime/mod.ts";
import {
  catalog,
  keyable,
  type ModelInfo,
  type ModelKeys,
  type Provider,
} from "../shared/choice.ts";

/** Most models a search answers. */
const FOUND = 50;

export type OfferedProvider = {
  id: string;
  name: string;
  models: number;
  ready: boolean;
  /** A key can be brought for it. */
  keyed: boolean;
  /** The end of the org's key, when it has one. */
  hint?: string;
  /** What to know before choosing it. */
  note?: string;
};

export type OfferedModel = {
  id: string;
  provider: string;
  /** Its provider's name. */
  from: string;
  name: string;
  context?: number;
  output?: number;
  input?: string[];
  reasons?: boolean;
  /** USD per million tokens. */
  price?: { input?: number; output?: number };
  released?: string;
  ready: boolean;
};

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const usable = (info: ModelInfo) => info.chat !== false && info.tools !== false && !info.deprecated;
const has = (words: string[], text: string) => words.every((word) => fold(text).includes(word));

const titled = (id: string, declared?: Provider) =>
  declared?.title ?? catalog.providers[id]?.name ?? id;

/** Where a provider's models are in the catalog: itself, or what it declares (`chatgpt`: openai's). */
const listedIn = (id: string, declared?: Provider) =>
  declared?.catalog === false ? undefined : catalog.providers[
    typeof declared?.catalog === "string" ? declared.catalog : id
  ];

const shownModel = (
  provider: string,
  from: string,
  name: string,
  info: ModelInfo,
  ready: boolean,
) => ({
  id: `${provider}/${name}`,
  provider,
  from,
  name: info.name ?? name,
  ...(info.context ? { context: info.context } : {}),
  ...(info.output ? { output: info.output } : {}),
  ...(info.input?.length ? { input: info.input } : {}),
  ...(info.reasoning ? { reasons: true } : {}),
  ...(info.cost ? { price: { input: info.cost.input, output: info.cost.output } } : {}),
  ...(info.released ? { released: info.released } : {}),
  ready,
});

const newest = (a: OfferedModel, b: OfferedModel) =>
  (b.released ?? "").localeCompare(a.released ?? "") || a.name.localeCompare(b.name);

/** Every provider there is to offer, in the order to show them. */
async function providersOf(ctx: Context): Promise<OfferedProvider[]> {
  const declared = (ctx.resources.provider ?? {}) as Record<string, Provider>;
  const keys = ctx.resources.modelKeys as ModelKeys | undefined;
  const kept = keys
    ? await ctx.as().call<{ provider: string; hint?: string }[]>(keys.list, {})
    : [];
  const hints = new Map(kept.map((k) => [k.provider, k.hint ?? "••••"]));
  const ids = new Set([
    ...Object.keys(declared),
    ...(keys ? Object.keys(catalog.providers).filter(keyable) : []),
  ]);
  const shown: OfferedProvider[] = [];
  for (const id of ids) {
    const own = declared[id];
    const listed = listedIn(id, own);
    if (!listed) continue;
    const count = Object.values(listed.models).filter(usable).length;
    if (!count) continue;
    const keyed = !!keys && keyable(id);
    const hint = hints.get(id);
    shown.push({
      id,
      name: titled(id, own),
      models: count,
      ready: !!(hint || own?.apiKey || own?.headers),
      keyed,
      ...(hint ? { hint } : {}),
      ...(own?.note ? { note: own.note } : {}),
    });
  }
  return shown.sort((a, b) =>
    Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name, "en")
  );
}

export const offered = defineAction({
  description: "The providers and models an agent can be given",
  record: false,
  input: {
    type: "object",
    properties: {
      provider: { type: "string" },
      search: { type: "string", maxLength: 100 },
      model: { type: "string" },
    },
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const declared = (ctx.resources.provider ?? {}) as Record<string, Provider>;
    const providers = await providersOf(ctx);
    const known = new Map(providers.map((p) => [p.id, p]));
    const modelsOf = (id: string): OfferedModel[] =>
      Object.entries(listedIn(id, declared[id])?.models ?? {})
        .filter(([, info]) => usable(info))
        .map(([name, info]) =>
          shownModel(id, titled(id, declared[id]), name, info, !!known.get(id)?.ready)
        );

    if (input.model) {
      const slash = input.model.indexOf("/");
      const id = input.model.slice(0, slash);
      const name = input.model.slice(slash + 1);
      const info = listedIn(id, declared[id])?.models[name];
      return {
        provider: known.get(id) ?? null,
        model: info
          ? shownModel(id, titled(id, declared[id]), name, info, !!known.get(id)?.ready)
          : null,
      };
    }
    if (input.provider) {
      return {
        provider: known.get(input.provider) ?? null,
        models: modelsOf(input.provider).sort(newest),
      };
    }
    const words = fold(input.search ?? "").split(/\s+/).filter(Boolean);
    if (words.length) {
      const models = providers.flatMap((p) =>
        modelsOf(p.id).filter((m) => has(words, `${p.name} ${p.id} ${m.name} ${m.id}`))
      );
      return {
        providers: providers.filter((p) => has(words, `${p.name} ${p.id}`)),
        // Those that can be used first, then the newest.
        models: models.sort((a, b) => Number(b.ready) - Number(a.ready) || newest(a, b))
          .slice(0, FOUND),
      };
    }
    const keys = ctx.resources.modelKeys as ModelKeys | undefined;
    const may = keys
      ? await ctx.call<{ set: boolean }>(keys.may, {}).catch(() => ({ set: false }))
      : { set: false };
    return { providers, set: may.set };
  },
});

export const keyableAction = defineAction({
  description: "Whether a key can be brought for a provider",
  record: false,
  input: {
    type: "object",
    properties: { provider: { type: "string" } },
    required: ["provider"],
    additionalProperties: false,
  },
  run: (_ctx, input) => keyable(input.provider),
});
