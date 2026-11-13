/**
 * Making images: the model choice resolved, the references read as the
 * caller, fallbacks and retries, the images kept, and the use told.
 *
 * - **References** are images to work from: one this port made (`{ id }`),
 *   a document the caller may read that holds a file as `type` and `data`
 *   (base64), such as chat's files (`{ id, collection: "file" }`), or one
 *   given inline (`{ data, type }`, or a data URL). Documents are read as
 *   the caller, so the rules decide.
 * - **What it made** is kept in the `image` collection, a document each, its
 *   content a blob, and answered by id, media type and size, with whatever
 *   the model said.
 * - **Before** each model: the org's own key, if it has one; whoever listens
 *   to model use, and the `spending` check, may refuse it, for good.
 * - **After** each answer, images or not: its use told (`modelUse`), tokens
 *   that the catalog prices as it prices `llm`'s.
 * - **Failures:** a call that breaks (the network, no answer for the
 *   provider's `silence`, a provider timing out or busy) is tried again for
 *   the provider's `retry` when it's the last model, and otherwise hands
 *   over to the next at once. A model that makes no image hands over too;
 *   one that refuses (its safety rules) stops there: another would refuse
 *   the same prompt, and every try costs.
 */
import type { Context } from "../../../runtime/mod.ts";
import { failure, invalid } from "../../../runtime/mod.ts";
import {
  adapterFor,
  loadCatalog,
  type ModelInfo,
  type ModelRef,
  type Provider,
  resolve,
  type Resolved,
} from "./choice.ts";
import { calledBy, type Endpoint, type Usage } from "./provider.ts";
import { awaited, backoff, RETRY, SILENCE, transient, wait } from "./retry.ts";
import { measure } from "./telemetry.ts";
import { keyed, mayRun, used } from "./use.ts";

/** What an image model choice may set, next to `model`: anything else for the request. */
export type ImageSettings = { options?: Record<string, unknown> };

/** An image, to a model or from one: its media type, and its content, base64. */
export type ImageData = { type: string; data: string };

/**
 * An image to work from: one this port made (`id`), a document of another
 * collection the caller may read holding `type` and `data` (`id` and
 * `collection`: chat's files are `"file"`), or one given inline (`data`,
 * base64 with its `type`, or a data URL).
 */
export type ImageReference = { id?: string; collection?: string; data?: string; type?: string };

export type ImageRequest = ImageSettings & {
  connection: Endpoint & { model: string };
  info?: ModelInfo;
  prompt: string;
  /** Images to work from, in order. */
  references: ImageData[];
  /** How many images to make (1 when not said). */
  count?: number;
  /** Their shape, width to height: `"16:9"`. */
  aspectRatio?: string;
  /** Their size, as the provider says it: Gemini's `"1K"`, `"2K"`, `"4K"`; OpenAI's `"1024x1536"`. */
  size?: string;
  signal?: AbortSignal;
};

/**
 * A model's answer: the images it made, what it said, what it used, and,
 * when it made none because its rules said no, why (`refused`).
 */
export type ImageAnswer = { images: ImageData[]; text: string; usage?: Usage; refused?: string };

/** An image port's adapter: one call, its whole answer. A refusal is an answer, not a throw. */
export type ImageAdapter = { generate(request: ImageRequest): Promise<ImageAnswer> };

/** An image kept: its id in the `image` collection, its media type, its size in bytes. */
export type ImageMade = { id: string; type: string; size: number };

/** What `image.generate` answers: the images kept, what the model said, and what it used. */
export type Images = { images: ImageMade[]; text: string; usage?: Usage & { model?: string } };

export type Generation = {
  /** `"provider/model"`, an alias, settings around one, or a list tried in order. */
  model: ModelRef;
  prompt: string;
  references?: ImageReference[];
  count?: number;
  aspectRatio?: string;
  size?: string;
  /** What it's for (thread, space, purpose…): its usage record's tags, and its images'. */
  tags?: Record<string, string>;
};

type Reach = Pick<
  Context,
  "db" | "resources" | "adapters" | "signal" | "as" | "actor" | "call" | "record" | "metrics"
>;

/** Where the images made are kept, and where a reference's `id` is looked for unless it says. */
export const IMAGES = "image";

/** The models a choice names, in order, each checked. */
export function imagers(
  ctx: Pick<Context, "resources" | "adapters">,
  model: ModelRef,
): Resolved[] {
  const resolved = resolve(ctx.resources, model);
  for (const m of resolved) adapterFor(ctx.adapters, "image", m);
  return resolved;
}

/** Bytes in base64 content. */
const sizeOf = (data: string) =>
  Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A reference's content: a document read as the caller (so the rules decide), or as given. */
async function referenced(ctx: Reach, reference: ImageReference, n: number): Promise<ImageData> {
  const which = `Reference ${n + 1}`;
  if ((reference.id === undefined) === (reference.data === undefined)) {
    throw invalid(`${which}: an \`id\` (and its \`collection\`) or \`data\`, one of them`);
  }
  let found: { type?: unknown; data?: unknown };
  if (reference.id !== undefined) {
    const collection = reference.collection ?? IMAGES;
    const doc = await ctx.db.collection<{ type?: unknown; data?: unknown }>(collection)
      .findOne({ _id: reference.id });
    if (!doc) {
      throw failure(
        "not_found",
        `${which}: no "${reference.id}" in ${collection} that you can read`,
      );
    }
    found = doc;
  } else {
    const url = /^data:([^;,]+);base64,/i.exec(reference.data!);
    found = url
      ? { type: url[1], data: reference.data!.slice(url[0].length) }
      : { type: reference.type, data: reference.data };
  }
  const type = typeof found.type === "string" ? found.type.split(";")[0].trim().toLowerCase() : "";
  if (!type.startsWith("image/")) {
    throw invalid(`${which} isn't an image: ${type || "its type isn't said"}`);
  }
  const data = typeof found.data === "string" ? found.data.replace(/\s+/g, "") : "";
  if (!data || !BASE64.test(data)) throw invalid(`${which}: its content isn't base64`);
  return { type, data };
}

/**
 * One model's answer. A call that breaks is tried again, waiting longer each
 * time, while it's the last model to try and its `retry` lasts.
 */
async function answered(
  ctx: Reach,
  m: Resolved,
  request: Generation,
  references: ImageData[],
  last: boolean,
): Promise<ImageAnswer> {
  const adapter = adapterFor<ImageAdapter>(ctx.adapters, "image", m);
  const { options } = m.settings as ImageSettings;
  const { silence = SILENCE, retry = RETRY } = m.endpoint as Provider;
  const until = Date.now() + retry;
  for (let attempt = 0;;) {
    const call = measure(ctx.metrics, m, "generate_content");
    const quiet = new AbortController();
    try {
      const answer = await awaited(
        adapter.generate({
          connection: { ...calledBy(m.endpoint, ctx), model: m.model },
          options,
          info: m.info,
          prompt: request.prompt,
          references,
          ...(request.count ? { count: request.count } : {}),
          ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
          ...(request.size ? { size: request.size } : {}),
          signal: AbortSignal.any([ctx.signal, quiet.signal]),
        }),
        silence,
        quiet,
      );
      call.end();
      if (answer.usage) call.usage(answer.usage);
      return answer;
    } catch (error) {
      call.end(error);
      if (ctx.signal.aborted) throw error;
      const pause = backoff(attempt + 1);
      if (last && transient(error) && Date.now() + pause <= until) {
        attempt++;
        await wait(pause, ctx.signal);
        if (ctx.signal.aborted) throw error;
        continue;
      }
      // A break it tried again for as long as it should is final: nobody tries it again.
      throw transient(error) ? Object.assign(error as Error, { final: true }) : error;
    }
  }
}

/** The images made, kept in the `image` collection, as the answer names them. */
async function kept(
  ctx: Reach,
  m: Resolved,
  answer: ImageAnswer,
  tags?: Record<string, string>,
): Promise<Images> {
  const at = new Date().toISOString();
  const docs = answer.images.map((image) => ({
    type: image.type,
    size: sizeOf(image.data),
    data: image.data,
    model: m.id,
    ...(tags ? { tags } : {}),
    at,
  }));
  const { insertedIds } = await ctx.db.collection(IMAGES).insertMany(docs);
  return {
    images: docs.map((doc, i) => ({ id: insertedIds[i], type: doc.type, size: doc.size })),
    text: answer.text,
    ...(answer.usage ? { usage: { ...answer.usage, model: m.id } } : {}),
  };
}

/** What a model said, after why it made nothing. */
const saying = (text: string) => text.trim() ? `: ${text.trim().slice(0, 500)}` : "";

/** Images from a prompt and references; with a list, a model that fails hands over to the next. */
export async function generateImages(ctx: Reach, request: Generation): Promise<Images> {
  await loadCatalog();
  const choices = imagers(ctx, request.model);
  if (!request.prompt.trim()) throw invalid("An image needs a prompt");
  const references = await Promise.all(
    (request.references ?? []).map((reference, n) => referenced(ctx, reference, n)),
  );
  let stopped: unknown;
  for (const [i, choice] of choices.entries()) {
    const last = i === choices.length - 1;
    let m: Resolved;
    let answer: ImageAnswer;
    try {
      m = await keyed(ctx, choice);
      await mayRun(ctx, m, "image", request.tags);
    } catch (error) {
      if ((error as { final?: boolean }).final) stopped ??= error;
      // No key for this one, or no credits: the next, if there is one.
      if (last) throw stopped ?? error;
      continue;
    }
    try {
      answer = await answered(ctx, m, request, references, last);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      // The last one failed, having been stopped earlier: that's what to tell them.
      if (last) throw stopped ?? error;
      continue;
    }
    // What it used is told whatever it made: the provider bills a refusal's tokens too.
    if (answer.usage) {
      await used(ctx, {
        meter: "image",
        subject: m.id,
        catalog: m.catalog,
        quantities: answer.usage,
        tags: m.tags ? { ...m.tags, ...request.tags } : request.tags,
      });
    }
    if (answer.images.length) return await kept(ctx, m, answer, request.tags);
    if (answer.refused) {
      throw Object.assign(
        failure(
          "image_refused",
          `${m.id} wouldn't make this image (${answer.refused})${saying(answer.text)}`,
          { public: true },
        ),
        { final: true },
      );
    }
    if (last) {
      throw stopped ??
        failure("no_image", `${m.id} made no image${saying(answer.text)}`, { public: true });
    }
  }
  throw invalid("No model chosen");
}
