/**
 * The models plugin's contract: what other plugins may import from it (types
 * only, no code), and the Actions they call it by, all unrecorded (inline in
 * a job; read-only from queries, Views and startup checks).
 *
 * - `llm.stream` { model, instructions?, messages, tools?, tags? } → AsyncIterable<LlmChunk>,
 *   from a job in the same process; `llm.generate` (the same, plus `stream`, a channel) →
 *   Completion
 * - `embeddings.embed` { model, input, tags? } → Embedding
 * - `transcription.transcribe` { model, audio (base64), type, filename?, tags? } → Transcript
 * - `models.check` { model, port: "llm" | "embeddings" | "transcription" }: throws what's wrong
 * - `models.price` { catalog } → Price
 * - the `modelUse` resource: UseListener entries, told each call's use in the job that made it
 */
import type { Cost } from "./shared/choice.ts";

export type {
  Cost,
  Media,
  ModelRef,
  ModelSettings,
  Prices,
  Provider,
  Resolved,
} from "./shared/choice.ts";
export type { Completion, Generate } from "./shared/generate.ts";
export type { Embedding } from "./shared/embed.ts";
export type { Transcript } from "./shared/transcribe.ts";
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
export type { ModelUse, UseContext, UseListener } from "./shared/use.ts";

/** What `models.price` answers: the catalog's cost for a model, and which catalog said it. */
export type Price = { cost?: Cost; source: string };
