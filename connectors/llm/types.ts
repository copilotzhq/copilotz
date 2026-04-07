/**
 * Multimodal content parts accepted by providers.
 *
 * Provider notes:
 * - OpenAI/Groq: supports `text`, `image_url` (http(s) or data URL), `input_audio` (base64), limited file via data URL images.
 * - Anthropic: supports `text`, images via URL or base64 data URL (mapped internally to Claude schema). System is text-only.
 * - Gemini: supports `text`, inline_data (from `image_url` data URL, `input_audio`, or `file` data URL).
 * - Ollama: accepts text and base64 images (we extract from data URLs into `images` array).
 * - DeepSeek: text only (non-text parts are ignored).
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
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
  tool_call_id?: string;
  // Prefer passing tool calls explicitly for assistant messages
  toolCalls?: ToolInvocation[];
}

export type ProviderFallbackReason =
  | "timeout"
  | "network"
  | "rate_limit"
  | "server_error"
  | "provider_error";

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
  maxLength?: number; // For message truncation

  // Response format
  responseType?: "text" | "json";
  stream?: boolean;
  outputReasoning?: boolean; // Whether to output thinking/reasoning tokens during stream (default true)

  // Advanced sampling parameters
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;

  // Stop sequences
  stop?: string | string[];
  stopSequences?: string[];

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
  verbosity?: "none" | "low" | "medium" | "high"; // OpenAI reasoning models (o3, o4)
}

export type ProviderFallbackConfig =
  & Omit<ProviderConfigBase, "provider">
  & { provider: ProviderName };

// Comprehensive configuration for AI providers with multimodal support
export interface ProviderConfig extends ProviderConfigBase {
  /** Ordered fallback models/providers to try when the primary attempt fails before any visible streaming output. */
  fallbacks?: ProviderFallbackConfig[];
  /** Error classes that are allowed to trigger a fallback attempt. */
  fallbackOn?: ProviderFallbackReason[];
}

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
}

// Provider API interface with multimodal support
export interface ProviderAPI {
  endpoint: string;
  headers: (config: ProviderConfig) => Record<string, string>;
  body: (messages: ChatMessage[], config: ProviderConfig) => any;
  /** Extract content/reasoning parts from a single parsed SSE or JSONL event. */
  extractContent: (data: any) => ExtractedPart[] | null;
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
