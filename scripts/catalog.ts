/**
 * Writes `plugins/models/shared/catalog.json`: what models.dev knows about every
 * provider and model, kept to what the runtime uses: how to reach a provider
 * (its protocol and URL), and per model its cost, how its reasoning is
 * controlled, what it reads besides text, and its limits.
 *
 *   deno task catalog
 *
 * The file is data the runtime trusts, so nothing is copied as it comes:
 * every field is checked, and URLs that aren't plain https are left out.
 */
const SOURCE = "https://models.dev/api.json";
const OUT = new URL("../plugins/models/shared/catalog.json", import.meta.url);

/** The protocol each models.dev SDK package speaks, as Copilotz's adapters are named. */
const PROTOCOLS: Record<string, string> = {
  "@ai-sdk/openai": "openai",
  "@ai-sdk/openai-compatible": "openai-compatible",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "gemini",
  "@ai-sdk/groq": "openai-compatible",
  "@ai-sdk/xai": "openai-compatible",
  "@ai-sdk/cerebras": "openai-compatible",
  "@ai-sdk/deepinfra": "openai-compatible",
  "@ai-sdk/togetherai": "openai-compatible",
  "@ai-sdk/mistral": "openai-compatible",
  "@ai-sdk/perplexity": "openai-compatible",
  "@openrouter/ai-sdk-provider": "openai-compatible",
  "venice-ai-sdk-provider": "openai-compatible",
};

/** OpenAI-compatible endpoints models.dev leaves to their SDK package. */
const URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  togetherai: "https://api.together.xyz/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  openrouter: "https://openrouter.ai/api/v1",
  venice: "https://api.venice.ai/api/v1",
};

const SHAPES: Record<string, string> = { completions: "openai-compatible", responses: "openai" };

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Raw : undefined;
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const url = (value: unknown) => {
  if (typeof value !== "string" || value.includes("${")) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
};
const compact = <T extends Raw>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** USD per million tokens, named as Copilotz's `Usage` names what they count. */
function prices(raw: Raw) {
  return compact({
    input: number(raw.input),
    output: number(raw.output),
    cached: number(raw.cache_read),
    cacheWrite: number(raw.cache_write),
    reasoning: number(raw.reasoning),
    audioInput: number(raw.input_audio),
    audioOutput: number(raw.output_audio),
  });
}

function cost(raw: Raw | undefined) {
  if (!raw || number(raw.input) === undefined) return undefined;
  // Prices that change past a prompt size: `context_over_200k` is the older form of a tier.
  const tiers = (Array.isArray(raw.tiers) ? raw.tiers : []).flatMap((t) => {
    const tier = object(object(t)?.tier);
    const above = number(tier?.size);
    return tier?.type === "context" && above ? [{ above, ...prices(object(t)!) }] : [];
  });
  const over = object(raw.context_over_200k);
  if (!tiers.length && over) tiers.push({ above: 200_000, ...prices(over) });
  return compact({ ...prices(raw), tiers: tiers.length ? tiers : undefined });
}

/** How a model's reasoning is controlled: effort levels, a token budget, on/off; false: it doesn't reason. */
function reasoning(model: Raw) {
  if (model.reasoning !== true) return model.reasoning === false ? false : undefined;
  const out: { effort?: string[]; budget?: { min?: number; max?: number }; toggle?: true } = {};
  for (const option of Array.isArray(model.reasoning_options) ? model.reasoning_options : []) {
    const o = object(option);
    if (o?.type === "effort" && Array.isArray(o.values)) {
      out.effort = o.values.filter((v): v is string => typeof v === "string");
    } else if (o?.type === "budget_tokens") {
      out.budget = compact({ min: number(o.min), max: number(o.max) });
    } else if (o?.type === "toggle") out.toggle = true;
  }
  return out;
}

/** Media a model can be given besides text, as models.dev names them. */
const MEDIA = ["image", "pdf", "audio", "video"];

/** What a model reads besides text (its input modalities); none: text only. */
function input(model: Raw) {
  const given = object(model.modalities)?.input;
  const kinds = Array.isArray(given) ? MEDIA.filter((kind) => given.includes(kind)) : [];
  return kinds.length ? kinds : undefined;
}

/** Whether a model answers in something other than text (an embedder, an image model). */
function chatless(model: Raw) {
  const output = object(model.modalities)?.output;
  return Array.isArray(output) && !output.includes("text");
}

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE}: ${response.status}`);
const raw = object(await response.json());
if (!raw) throw new Error(`${SOURCE}: not an object`);

const providers: Record<string, Raw> = {};
for (const [id, value] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
  const provider = object(value);
  if (!provider) continue;
  const npm = typeof provider.npm === "string" ? provider.npm : "";
  const models: Record<string, Raw> = {};
  for (const [name, m] of Object.entries(object(provider.models) ?? {})) {
    const model = object(m);
    if (!model) continue;
    const limit = object(model.limit);
    const own = object(model.provider);
    const entry = compact({
      name: typeof model.name === "string" ? model.name : undefined,
      released: typeof model.release_date === "string" ? model.release_date : undefined,
      // Only what an agent couldn't work with is said: no tools, or nothing to read back.
      tools: model.tool_call === false ? false : undefined,
      chat: chatless(model) ? false : undefined,
      deprecated: model.status === "deprecated" ? true : undefined,
      protocol: (own && (SHAPES[own.shape as string] ?? PROTOCOLS[own.npm as string])) ||
        undefined,
      api: url(own?.api),
      cost: cost(object(model.cost)),
      reasoning: reasoning(model),
      input: input(model),
      output: number(limit?.output),
      context: number(limit?.context),
    });
    if (Object.keys(entry).length) models[name] = entry;
  }
  providers[id] = compact({
    name: typeof provider.name === "string" ? provider.name : undefined,
    protocol: PROTOCOLS[npm],
    api: url(provider.api) ?? URLS[id],
    models,
  });
}

// Unchanged data leaves the file as it is, fetch date included: no change, no diff.
try {
  const before = JSON.parse(await Deno.readTextFile(OUT)) as { providers: unknown };
  if (JSON.stringify(before.providers) === JSON.stringify(providers)) {
    console.log("unchanged");
    Deno.exit(0);
  }
} catch {
  // No snapshot yet.
}

// One model per line, so a week's price changes read as a short diff.
const lines = [
  "{",
  `  "source": ${JSON.stringify(SOURCE)},`,
  `  "fetched": ${JSON.stringify(new Date().toISOString().slice(0, 10))},`,
  `  "etag": ${JSON.stringify(response.headers.get("etag") ?? "")},`,
  `  "providers": {`,
  Object.entries(providers).map(([id, { models, ...rest }]) =>
    [
      `    ${JSON.stringify(id)}: {`,
      ...Object.entries(rest).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
      `      "models": {`,
      Object.entries(models as Raw).map(([name, m]) =>
        `        ${JSON.stringify(name)}: ${JSON.stringify(m)}`
      ).join(",\n"),
      `      }`,
      `    }`,
    ].join("\n")
  ).join(",\n"),
  "  }",
  "}",
  "",
];
await Deno.writeTextFile(OUT, lines.join("\n"));
const count = Object.values(providers).reduce((n, p) => n + Object.keys(p.models as Raw).length, 0);
console.log(`${Object.keys(providers).length} providers, ${count} models → ${OUT.pathname}`);
