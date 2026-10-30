/**
 * Choosing a model, for every port (llm, embeddings, transcription).
 *
 * - A `provider` resource says where and how to reach a provider: an account
 *   or an endpoint. Its name is the provider's id: `openai`, `deepseek`, or a
 *   name of your own (`chatgpt`, `work-azure`).
 * - A model is `"provider/model"`, with the settings to call it with next to
 *   it (`effort`, `maxTokens`, … by port). A list is tried in order. A name
 *   without a slash is an alias from `resources.model`.
 * - The catalog (models.dev, snapshotted in `catalog.json`) fills in what a
 *   provider resource leaves out: its protocol and URL, and per model its
 *   cost, how its reasoning is controlled and its limits.
 */
import catalogJson from "./catalog.json" with { type: "json" };
import type { Endpoint } from "./provider.ts";

/** USD per million tokens, by what `Usage` counts; `tiers` apply past a prompt size. */
export type Prices = {
  input?: number;
  output?: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
  audioInput?: number;
  audioOutput?: number;
};
export type Cost = Prices & { tiers?: (Prices & { above: number })[] };

/** What the catalog knows about a model. */
export type ModelInfo = {
  /** Its protocol and URL, where they differ from its provider's. */
  protocol?: string;
  api?: string;
  cost?: Cost;
  /** How reasoning is controlled: effort levels, a token budget, on/off. False: it doesn't reason. */
  reasoning?: false | {
    effort?: string[];
    budget?: { min?: number; max?: number };
    toggle?: true;
  };
  /** What it reads besides text (models.dev's input modalities); none: text only. */
  input?: Media[];
  /** Most tokens it writes, and reads plus writes. */
  output?: number;
  context?: number;
};

/** Media a model may read besides text. */
export type Media = "image" | "pdf" | "audio" | "video";

export type Catalog = {
  source: string;
  fetched: string;
  etag: string;
  providers: Record<string, { protocol?: string; api?: string; models: Record<string, ModelInfo> }>;
};

export const catalog = catalogJson as unknown as Catalog;

/**
 * A `provider` resource. Everything is optional for a provider the catalog
 * knows: `deepseek: { apiKey }` is enough.
 */
export type Provider = Endpoint & {
  /** The protocol it speaks, which names each port's adapter: `openai`, `openai-compatible`, `anthropic`, `gemini`, or a plugin's own. */
  adapter?: string;
  /** The catalog provider its models are looked up in (default: its own name); false for none. */
  catalog?: string | false;
  /** How long (ms) a model may send nothing before its connection counts as dropped (2 minutes). */
  silence?: number;
  /**
   * How long (ms) a call that broke (the network, a silent stream, the
   * provider timing out or busy) is tried again, waiting longer each time
   * (2 minutes; 0: never).
   */
  retry?: number;
};

/** A model to call: `"provider/model"`, an alias, settings around one, or a list tried in order. */
export type ModelRef = string | ModelSettings | ModelRef[];

/** Settings next to a model. Each port reads its own (llm: `effort`, `maxTokens`, …). */
export type ModelSettings = {
  model: ModelRef;
  /** The catalog entry (`"provider/model"`) when the name differs there, as an Azure deployment's does. */
  catalog?: string;
  /** Anything else for the request, as it is. */
  options?: Record<string, unknown>;
  /** What it reads besides text, where the catalog doesn't know it (or is wrong): `["image"]`. */
  input?: Media[];
  [setting: string]: unknown;
};

/** One model, ready to call. */
export type Resolved = {
  /** `"provider/model"`, as chosen. */
  id: string;
  provider: string;
  /** The model's name at the provider. */
  model: string;
  adapter: string;
  endpoint: Endpoint;
  /** Its catalog entry's id and what it knows, when there is one. */
  catalog?: string;
  info?: ModelInfo;
  settings: Record<string, unknown>;
};

type Resources = Record<string, Record<string, unknown> | undefined>;

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/** Inner settings over outer ones; `options` merge. */
const over = (outer: Record<string, unknown>, inner: Record<string, unknown>) => {
  const merged = { ...outer, ...inner };
  if (outer.options || inner.options) {
    merged.options = { ...outer.options as object, ...inner.options as object };
  }
  return merged;
};

const defined = (settings: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));

/** The models a ref names, in order, each with its settings. */
function choices(
  resources: Resources,
  ref: ModelRef,
  inherited: Record<string, unknown>,
  aliases: string[],
): { id: string; settings: Record<string, unknown> }[] {
  if (Array.isArray(ref)) return ref.flatMap((r) => choices(resources, r, inherited, aliases));
  if (typeof ref === "string") {
    if (ref.includes("/")) return [{ id: ref, settings: inherited }];
    const alias = resources.model?.[ref] as ModelRef | undefined;
    if (alias === undefined) {
      throw invalid(`No model "${ref}": use "provider/model", or name one in resources.model`);
    }
    if (aliases.includes(ref)) throw invalid(`Model alias "${ref}" names itself`);
    // An alias holds defaults: what is set where it is used wins.
    return choices(resources, alias, {}, [...aliases, ref])
      .map((c) => ({ id: c.id, settings: over(c.settings, inherited) }));
  }
  const { model, ...settings } = ref;
  if (model === undefined) throw invalid("Model settings without a `model`");
  return choices(resources, model, over(inherited, defined(settings)), aliases);
}

/** Looks a model up in the catalog: `"provider/model"`. */
export function lookup(id: string): ModelInfo | undefined {
  const slash = id.indexOf("/");
  return catalog.providers[id.slice(0, slash)]?.models[id.slice(slash + 1)];
}

/**
 * The models a ref names, in the order to try them, each with where to send
 * it and what's known about it. Throws when one can't be called.
 */
export function resolve(resources: Resources, ref: ModelRef): Resolved[] {
  const found = choices(resources, ref, {}, []);
  if (!found.length) throw invalid("No model chosen");
  return found.map(({ id, settings }) => {
    const slash = id.indexOf("/");
    const provider = id.slice(0, slash);
    const model = id.slice(slash + 1);
    const declared = resources.provider?.[provider] as Provider | undefined;
    if (!declared) {
      throw invalid(
        `No provider "${provider}" for "${id}": declare resources.provider.${provider}`,
      );
    }
    const { adapter, catalog: from, ...endpoint } = declared;
    const listed = from === false ? undefined : catalog.providers[from ?? provider];
    const entry = typeof settings.catalog === "string"
      ? settings.catalog
      : listed && model in listed.models
      ? `${from ?? provider}/${model}`
      : undefined;
    const info = entry ? lookup(entry) : undefined;
    const speaks = adapter ?? info?.protocol ?? listed?.protocol;
    if (!speaks) {
      throw invalid(`Provider "${provider}" needs an \`adapter\`: the protocol it speaks`);
    }
    const { catalog: _, ...rest } = settings;
    return {
      id,
      provider,
      model,
      adapter: speaks,
      endpoint: {
        ...endpoint,
        ...(endpoint.baseURL ? {} : { baseURL: info?.api ?? listed?.api }),
      },
      ...(entry ? { catalog: entry } : {}),
      ...(info ? { info } : {}),
      settings: rest,
    };
  });
}

/** A port's adapter for a resolved model. */
export function adapterFor<A>(
  adapters: Record<string, Record<string, unknown> | undefined>,
  port: string,
  model: Resolved,
): A {
  const adapter = adapters[port]?.[model.adapter] as A | undefined;
  if (!adapter) {
    throw invalid(
      `No ${port} adapter "${model.adapter}" for "${model.id}"` +
        ` (${port} adapters: ${Object.keys(adapters[port] ?? {}).join(", ") || "none"})`,
    );
  }
  return adapter;
}
