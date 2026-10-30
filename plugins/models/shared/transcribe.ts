/** Transcribing: the model choice resolved, fallbacks, and its use told. */
import type { Actor, Context, ReadContext } from "../../../runtime/mod.ts";
import { calledBy, type Endpoint, type Usage } from "./provider.ts";
import { adapterFor, type ModelInfo, type ModelRef, resolve, type Resolved } from "./choice.ts";
import { used } from "./use.ts";
import { measure } from "./telemetry.ts";

/** What a transcription model choice may set, next to `model`. */
export type TranscriptionSettings = { options?: Record<string, string> };

export type Audio = {
  data: Uint8Array;
  /** The audio's media type, for example `audio/webm` or `audio/mpeg`. */
  type: string;
  filename?: string;
  /** The spoken language (ISO-639-1), when known: faster and more accurate. */
  language?: string;
  /** Context that helps: names, terms, the previous sentence. */
  prompt?: string;
};

/** The text, and what transcribing cost: tokens, or seconds of audio, by model; `usage.model` names it. */
export type Transcript = { text: string; usage?: Usage & { model?: string } };

export type TranscriptionRequest = TranscriptionSettings & {
  connection: Endpoint & { model: string };
  info?: ModelInfo;
  audio: Audio;
  signal?: AbortSignal;
};

export type TranscriptionAdapter = {
  transcribe(request: TranscriptionRequest): Promise<Transcript>;
};

type Reach = Pick<Context, "resources" | "adapters" | "signal"> & {
  actor?: Actor;
  call?: ReadContext["call"];
  record?: Context["record"];
  metrics?: Context["metrics"];
};

/** The models a choice names, in order, each checked. */
export function transcribers(
  ctx: Pick<Context, "resources" | "adapters">,
  model: ModelRef,
): Resolved[] {
  const resolved = resolve(ctx.resources, model);
  for (const m of resolved) adapterFor(ctx.adapters, "transcription", m);
  return resolved;
}

/** Speech to text; with a list, a model that fails hands over to the next. */
export async function transcribe(
  ctx: Reach,
  request: { model: ModelRef; audio: Audio; tags?: Record<string, string> },
): Promise<Transcript> {
  const choices = transcribers(ctx, request.model);
  for (const [i, m] of choices.entries()) {
    const call = measure(ctx.metrics, m, "transcription");
    try {
      const { options } = m.settings as TranscriptionSettings;
      const transcript = await adapterFor<TranscriptionAdapter>(ctx.adapters, "transcription", m)
        .transcribe({
          connection: { ...calledBy(m.endpoint, ctx), model: m.model },
          options,
          info: m.info,
          audio: request.audio,
          signal: ctx.signal,
        });
      call.end();
      if (!transcript.usage) return transcript;
      call.usage(transcript.usage);
      await used(ctx, {
        meter: "transcription",
        subject: m.id,
        catalog: m.catalog,
        quantities: { ...transcript.usage, model: undefined },
        tags: m.tags ? { ...m.tags, ...request.tags } : request.tags,
      });
      return { ...transcript, usage: { ...transcript.usage, model: m.id } };
    } catch (error) {
      call.end(error);
      if (i === choices.length - 1 || ctx.signal.aborted) throw error;
    }
  }
  throw new Error("No model chosen");
}
