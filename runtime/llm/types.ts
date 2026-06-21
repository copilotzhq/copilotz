/**
 * Multimodal content parts accepted by providers.
 *
 * Provider notes:
 * - Asset refs are materialized per provider attempt before adapter calls.
 * - OpenAI/Groq: supports `text`, `image_url` (http(s) or data URL), and selected audio/file shapes by model.
 * - Anthropic: supports `text` and images via URL or base64 data URL (mapped internally to Claude schema). System is text-only.
 * - Gemini: supports `text` and inline_data derived from image/audio parts. Generic file inlining is intentionally conservative.
 * - Ollama: accepts text and base64 images (we extract from data URLs into `images` array).
 * - DeepSeek: text only (non-text parts are ignored).
 * - MiniMax (Anthropic-compatible Messages API): supports `text`, `image`, and `video` (MiniMax-M3 only).
 *   The `video` part carries a data URL, public URL, or `mm_file://{file_id}` reference.
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video"; video: { url: string; mime_type?: string } }
  | { type: "input_audio"; input_audio: { data: string; format?: string } }
  | { type: "file"; file: { file_data: string; mime_type?: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "tool_result";
  /**
   * Either a plain text string or an array of multimodal parts.
   *
   * Examples:
   * - "Explain this image"
   * - [ { type: 'text', text: 'Describe this:' }, { type: 'image_url', image_url: { url: 'https://...' } } ]
   * - [ { type: 'input_audio', input_audio: { data: '<base64>', format: 'wav' } } ]
   */
  content: string | ChatContentPart[];
  /** Internal sender identity used for history-aware message normalization. */
  senderId?: string;
  /** Internal metadata used to reconstruct hidden control blocks for model-facing history. */
  metadata?: Record<string, unknown>;
  tool_call_id?: string;
  // Prefer passing tool calls explicitly for assistant messages
  toolCalls?: ToolInvocation[];
}

export type ProviderFallbackReason =
  | "timeout"
  | "network"
  | "auth_error"
  | "rate_limit"
  | "server_error"
  | "provider_error"
  | "unknown";

export interface ProviderConfigBase {
  // Provider selection
  provider?: ProviderName;
  apiKey?: string;

  // Model configuration
  model?: string;
  temperature?: number;

  // Token limits
  maxTokens?: number;
  maxCompletionTokens?: number;
  limitEstimatedInputTokens?: number; // Approximate input/history budget using rough token estimation

  // Response format
  responseType?: "text" | "json";
  stream?: boolean;
  /** Abort a provider attempt if no model stream activity arrives before this many milliseconds. Defaults to 20_000. Set <= 0 to disable. */
  firstTokenTimeoutMs?: number;
  /** Abort a provider attempt if model stream activity stalls for this many milliseconds after the first activity. Defaults to 5_000. Set <= 0 to disable. */
  streamIdleTimeoutMs?: number;
  outputReasoning?: boolean; // Whether to output thinking/reasoning tokens during stream (default true)
  estimateCost?: boolean; // Whether to estimate cost using OpenRouter pricing data (default true)
  pricingModelId?: string; // Explicit OpenRouter model id override for cost estimation
  /**
   * Provider prompt/context cache controls.
   *
   * Defaults to provider-native automatic caching when available:
   * - Anthropic: top-level automatic prompt caching (`cache_control`)
   * - Gemini 2.5+: implicit context caching
   *
   * Set `enabled: false` to avoid sending explicit cache directives.
   */
  promptCache?: {
    enabled?: boolean;
    mode?: "auto" | "implicit" | "explicit";
    /** Anthropic supports `5m` (default) and `1h`; Gemini explicit cache accepts duration strings like `300s`. */
    ttl?: "5m" | "1h" | `${number}s`;
    /** Gemini cached content resource, e.g. `cachedContents/abc123`. */
    cachedContent?: string;
    /** Gemini display name when Copilotz creates a best-effort explicit cache. */
    displayName?: string;
  } | boolean;

  // Advanced sampling parameters
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;

  // Stop sequences
  stop?: string | string[];
  stopSequences?: string[];
  /**
   * Internal, runtime-resolved stop sequences forwarded to providers that
   * support native stop handling (Anthropic, Gemini, MiniMax).
   *
   * Set by {@link runProviderStream} to the merged client-side stop set
   * (user `stop`/`stopSequences` plus Copilotz control tags like
   * `<tool_results>`), so providers can halt generation server-side in
   * addition to the always-on client-side enforcement. Not part of the
   * public config surface; callers should use `stop`/`stopSequences`.
   */
  nativeStopSequences?: string[];

  // Randomization
  seed?: number;

  /* Provider-specific parameters */

  // Custom base URL (Ollama, self-hosted)
  baseUrl?: string; // Custom base URL (Ollama, self-hosted)

  // Gemini-specific parameters
  candidateCount?: number; // Gemini
  responseMimeType?: string; // Gemini JSON format
  /**
   * Merged into `generationConfig.thinkingConfig` when streaming thoughts is enabled.
   * Use `includeThoughts: false` to disable even on thinking-capable models.
   * Use `includeThoughts: true` to force-enable on models you know support thinking.
   *
   * @see https://ai.google.dev/api/generate-content#ThinkingConfig
   */
  geminiThinkingConfig?: {
    includeThoughts?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: string;
  };

  // Ollama-specific parameters
  repeatPenalty?: number; // Ollama
  numCtx?: number; // Ollama context window

  // Anthropic-specific parameters
  metadata?: Record<string, any>; // Anthropic

  /**
   * Unified reasoning effort across providers. Each provider maps this to its native param:
   * - OpenAI: `reasoning_effort`
   * - Gemini 3.x: `thinkingConfig.thinkingLevel`
   * - Anthropic: `thinking.budget_tokens` (approximate mapping)
   *
   * Provider-specific overrides (geminiThinkingConfig, etc.) take precedence when set.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";

  // OpenAI-specific parameters
  user?: string; // OpenAI user identifier
  /** OpenAI transport selection. Defaults to `auto`: Responses API for current supported families, Chat Completions otherwise. */
  openaiApi?: "auto" | "responses" | "chat_completions";
  /** OpenAI Responses reasoning summary mode. Defaults to `auto` for reasoning-capable Responses models; set false to omit. */
  openaiReasoningSummary?: "auto" | "concise" | "detailed" | false;
  /** OpenAI `prompt_cache_key`, used to route requests that share common prompt prefixes. */
  openaiPromptCacheKey?: string;
  /** OpenAI `prompt_cache_retention` policy. */
  openaiPromptCacheRetention?: "in_memory" | "24h";
  verbosity?: "none" | "low" | "medium" | "high"; // OpenAI reasoning models (o3, o4)
}

export type LLMConfigBase = Omit<ProviderConfigBase, "apiKey">;

export type LLMFallbackConfig =
  & Omit<LLMConfigBase, "provider">
  & { provider: ProviderName };

/** Persisted LLM configuration that omits secret API keys. */
export interface LLMConfig extends LLMConfigBase {
  /** Ordered fallback models/providers to try when the primary attempt fails before any visible streaming output. */
  fallbacks?: LLMFallbackConfig[];
}

export type ProviderFallbackConfig =
  & Omit<ProviderConfigBase, "provider">
  & { provider: ProviderName };

// Comprehensive configuration for AI providers with multimodal support
export interface ProviderConfig extends ProviderConfigBase {
  /** Ordered fallback models/providers to try when the primary attempt fails before any visible streaming output. */
  fallbacks?: ProviderFallbackConfig[];
}

/** Runtime LLM provider configuration, including provider credentials. */
export type LLMRuntimeConfig = ProviderConfig;

// Tool definition for standardized tool calling
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

// Input for chat requests with multimodal support
export interface ChatRequest {
  messages: ChatMessage[];
  instructions?: string;
  config?: ProviderConfig;
  answer?: string; // For mock responses
  tools?: ToolDefinition[]; // Tool definitions for standardized tool calling
  tool_call_id?: string;
  /**
   * Custom XML-like block tags to extract and remove from assistant output.
   * Example: ["route_to"] extracts `<route_to>writer</route_to>`.
   */
  extractTags?: string[];
  /**
   * Optional late materialization hook for provider-attempt-specific message
   * shaping. Used for asset refs so fallbacks do not inherit another
   * provider's media/file wire format.
   */
  materializeMessages?: (
    messages: ChatMessage[],
    config: ProviderConfig,
  ) => Promise<ChatMessage[]> | ChatMessage[];
  /**
   * Controls whether reasoning from an interrupted/recovered same-agent attempt
   * is included in the synthetic retry context. Defaults to the framework
   * history policy: `{ include: "self", maxChars: 2000 }`.
   */
  reasoningHistory?: {
    include?: "none" | "self" | "all";
    maxChars?: number;
  };
  /** Optional external signal for cancelling active provider work. */
  signal?: AbortSignal;
}

// Unified Tool Invocation payload mapping executions end-to-end
export interface ToolInvocation {
  id: string; // The LLM-assigned unique execution ID (e.g. call_12345)
  tool: {
    id: string; // The programmatic tool key
    name?: string; // Optional human-readable tool title
  };
  args: string; // JSON string of arguments
  output?: unknown; // Present when the tool completes
  status?:
    | "pending"
    | "processing"
    | "completed"
    | "failed"
    | "expired"
    | "overwritten";
  // Internal batch aggregator metadata
  batchId?: string | null;
  batchSize?: number | null;
  batchIndex?: number | null;
}

// Response from chat completions with media processing results
export interface ChatResponse {
  prompt: ChatMessage[];
  answer: string;
  reasoning?: string;
  tokens: number;
  finishReason?: ProviderFinishReason | null;
  usage?: TokenUsage;
  usageFinalized?: Promise<FinalizedTokenUsage | null>;
  usageAttempts?: LLMUsageAttempt[];
  cost?: CostBreakdown;
  provider?: ProviderName;
  model?: string;
  toolCalls?: ToolInvocation[];
  extractedTags?: Record<string, string[]>;
  metadata?: {
    provider?: ProviderName;
    timestamp: string;
    messageCount: number;
  };
}

// Stream callback function options
export interface StreamCallbackOptions {
  isReasoning?: boolean;
}

// Stream callback function
export type StreamCallback = (
  chunk: string,
  options?: StreamCallbackOptions,
) => void;

// A single extracted chunk from a parsed SSE/JSONL event.
// Providers return an array of these from extractContent so the shared
// processStream can handle reasoning vs content uniformly.
export interface ExtractedPart {
  text: string;
  isReasoning?: boolean;
}

export interface ProviderUsageUpdate {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  rawUsage?: Record<string, unknown> | null;
}

export type ProviderFinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls"
  | "error"
  | "unknown";

export interface TokenUsage extends ProviderUsageUpdate {
  source: "provider" | "estimated";
  status: "completed" | "locally_stopped" | "aborted";
  statusReason?: TokenUsageStatusReason;
  stopSequence?: string;
}

export type TokenUsageStatusReason =
  | "local_stop_sequence"
  | "length"
  | "error"
  | "timeout"
  | "network"
  | "auth_error"
  | "rate_limit"
  | "server_error"
  | "provider_error"
  | "unknown"
  | "content_filter"
  | "empty_response"
  | "malformed_tool_call"
  | "visible_reasoning_markup"
  | "degenerate_repetition";

export interface LLMUsageAttempt {
  attemptId?: string;
  provider?: ProviderName;
  model?: string;
  usage: TokenUsage;
  cost?: CostBreakdown;
  visibleOutputStarted?: boolean;
  usageFinalized?: Promise<FinalizedTokenUsage | null>;
}

export interface FinalizedTokenUsage {
  usage: TokenUsage;
  cost?: CostBreakdown;
  tokens: number;
  finishReason: ProviderFinishReason | null;
  finalizedAt: string;
}

export interface CostBreakdown {
  source: "openrouter";
  currency: "USD";
  pricingModelId: string;
  inputCostUsd?: number;
  outputCostUsd?: number;
  reasoningCostUsd?: number;
  cacheReadInputCostUsd?: number;
  cacheCreationInputCostUsd?: number;
  totalCostUsd: number;
}

// Options for the shared processStream in utils.ts
export interface ProcessStreamOptions {
  config?: ProviderConfig;
  /** 'sse' (default) for `data: {...}` lines, 'jsonl' for raw JSON-per-line (Ollama). */
  format?: "sse" | "jsonl";
  /** Transform the accumulated raw response before returning (e.g. strip wrapper tags). */
  postProcess?: (raw: string) => string;
  /** Additional block tags to hide from visible streaming output while preserving raw content. */
  extractedBlockTags?: string[];
  /** Local stop sequences enforced client-side across all providers. */
  localStopSequences?: string[];
  /** Called when a local stop sequence is matched. */
  onLocalStop?: (matchedStop: string) => void;
  /** Continue draining the provider stream for final usage after local stop. */
  continueAfterLocalStop?: boolean;
  /** Extract provider-reported usage from a parsed SSE or JSONL event. */
  extractUsage?: (data: any) => ProviderUsageUpdate | null;
  /** Extract provider finish reason from a parsed SSE or JSONL event. */
  extractFinishReason?: (data: any) => ProviderFinishReason | null;
}

// Provider API interface with multimodal support
export interface ProviderAPI {
  endpoint: string;
  headers: (config: ProviderConfig) => Record<string, string>;
  body: (messages: ChatMessage[], config: ProviderConfig) => any | Promise<any>;
  /** Extract content/reasoning parts from a single parsed SSE or JSONL event. */
  extractContent: (data: any) => ExtractedPart[] | null;
  /** Report whether a parsed stream event represents provider/model progress even without text. */
  isStreamActivity?: (data: any) => boolean;
  /** Extract usage from a single parsed SSE or JSONL event when the provider exposes it. */
  extractUsage?: (data: any) => ProviderUsageUpdate | null;
  /** Extract a normalized finish reason from a single parsed SSE or JSONL event. */
  extractFinishReason?: (data: any) => ProviderFinishReason | null;
  transformMessages?: (messages: ChatMessage[]) => any;
  /** Options passed to the shared processStream (format, config, postProcess). */
  streamOptions?: Omit<ProcessStreamOptions, "config">;
}

// Provider factory function signature - now much simpler
export interface ProviderFactory {
  (config: ProviderConfig): ProviderAPI;
}

// LLM-specific providers
export type LLMProviderName =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "deepseek"
  | "minimax"
  | "ollama"
  | "xai";

// All supported providers (includes LLM, embedding, image generation, speech-to-text, and text-to-speech providers)
export type ProviderName = // LLM providers
  LLMProviderName;

// Provider registry
export interface ProviderRegistry {
  [key: string]: ProviderFactory;
}

// Base connector interface (now unused, keeping for backwards compatibility)
export interface ChatConnector {
  (request: ChatRequest, stream?: StreamCallback): Promise<ChatResponse>;
}
