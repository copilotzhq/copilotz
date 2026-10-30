/** The LLM port: one message format and one stream of chunks for every provider. */
import type { JSONSchema } from "../../../runtime/mod.ts";
import type { Endpoint, Usage } from "./provider.ts";
import type { Media, ModelInfo } from "./choice.ts";

export type { Usage };

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

/**
 * What a provider needs back with its own answer in the next calls, opaque to
 * everyone else: Anthropic's signed thinking, Gemini's thought signatures.
 * `by` is the model that wrote it (`"provider/model"`); it goes back to that
 * model only.
 */
export type LlmState = { by?: string; data: unknown };

/**
 * A file given with a message: its name, media type and content (base64). A
 * model that reads its kind (an image, a PDF) gets it; any other is told it
 * isn't shown (see `filesFor`).
 */
export type LlmFile = { name: string; type: string; data: string };

/**
 * `cache`: the prompt up to and including this message is a good cache point
 * (it repeats in the next calls). Providers that cache only where told
 * (Anthropic) mark it; the others cache prefixes on their own.
 */
export type LlmMessage =
  | { role: "user"; text: string; files?: LlmFile[]; cache?: true }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[]; state?: LlmState; cache?: true }
  | { role: "tool"; toolCallId: string; text: string; cache?: true };

export type LlmTool = { name: string; description: string; input: JSONSchema };

/** `usage` names the model that answered (`"provider/model"`): with fallbacks, not always the first. */
export type LlmChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "state"; state: LlmState }
  | ({ type: "usage"; model?: string } & Usage)
  /**
   * The call broke (the network, a silent stream, the provider busy): what it
   * sent so far is void, and it's tried again in `wait` ms (its `attempt`th
   * time). Only `generate` sends it; adapters don't.
   */
  | { type: "retry"; attempt: number; wait: number; reason: string };

/**
 * How hard a reasoning model thinks, in models.dev's words. Each adapter maps
 * it to its provider's setting; the catalog says which levels a model takes.
 */
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What an llm model choice may set, next to `model`. */
export type LlmSettings = {
  effort?: Effort;
  /** Most tokens to write (default: the provider's, or for Anthropic, which needs one, up to 32K). */
  maxTokens?: number;
  temperature?: number;
  /** Anything else, into the request body as it is (last, so it wins). */
  options?: Record<string, unknown>;
};

/** One call, as an adapter gets it: where, which model, its settings, and what the catalog knows. */
export type LlmRequest = LlmSettings & {
  connection: Endpoint & { model: string };
  info?: ModelInfo;
  instructions?: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  signal?: AbortSignal;
};

/** An adapter speaks one protocol. Its `state` chunks carry only `data`. */
export type LlmAdapter = {
  /** The media it sends its provider with a message (models.dev's names); none: text only. */
  media?: Media[];
  generate(request: LlmRequest): AsyncIterable<LlmChunk>;
};
