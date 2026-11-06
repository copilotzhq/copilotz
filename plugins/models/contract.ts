/**
 * The models plugin's contract: what other plugins may import from it (types
 * only, no code), and the Actions they call it by, unrecorded but for
 * `image.generate` (inline in a job; read-only from queries, Views and
 * startup checks).
 *
 * - `llm.stream` { model, instructions?, messages, tools?, tags? } → AsyncIterable<LlmChunk>,
 *   from a job in the same process; `llm.generate` (the same, plus `stream`, a channel) →
 *   Completion
 * - `embeddings.embed` { model, input, tags? } → Embedding
 * - `transcription.transcribe` { model, audio (base64), type, filename?, tags? } → Transcript
 * - `image.generate` { model, prompt, references?, count?, aspectRatio?, size?, tags? } → Images:
 *   recorded (a job run again finds it done); each reference `{ id, collection? }` (a document
 *   the caller may read, holding `type` and `data`; an image made here by default) or
 *   `{ data, type? }` (base64, or a data URL)
 * - the `image` collection: the images made (Image), read by id
 * - `models.check` { model, port: "llm" | "embeddings" | "transcription" | "image" }: throws what's wrong
 * - `models.efforts` { model } → string[] | null: the efforts the catalog says it takes
 * - `models.price` { catalog } → Price
 * - `models.offered` { provider?, search?, model? }: what an agent can be given
 * - `models.keyable` { provider } → boolean: whether a key can be brought for it
 * - the `modelKeys` resource: where orgs' own keys are kept (ModelKeys)
 * - the `modelUse` resource: UseListener entries, told each call's use in the job that made it
 */
import type { Cost } from "./shared/choice.ts";

export type {
  Cost,
  Media,
  ModelKeys,
  ModelRef,
  ModelSettings,
  Prices,
  Provider,
  Resolved,
} from "./shared/choice.ts";
export type { Caller } from "./shared/provider.ts";
export type { OfferedModel, OfferedProvider } from "./actions/offered.ts";
export type { Completion, Generate } from "./shared/generate.ts";
export type { Embedding } from "./shared/embed.ts";
export type { Transcript } from "./shared/transcribe.ts";
export type { ImageMade, ImageReference, Images } from "./shared/image.ts";
export type { Image } from "./collections/image.ts";
export type {
  Effort,
  LlmAdapter,
  LlmChunk,
  LlmFile,
  LlmMessage,
  LlmRequest,
  LlmState,
  LlmTool,
  ToolCall,
} from "./shared/types.ts";
export type { ModelCall, ModelUse, UseContext, UseListener } from "./shared/use.ts";

/** What `models.price` answers: the catalog's cost for a model, and which catalog said it. */
export type Price = { cost?: Cost; source: string };
