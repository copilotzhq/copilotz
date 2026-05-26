import type {
  ChatContentPart,
  ChatMessage,
  ExtractedPart,
  ProviderConfig,
  ProviderFactory,
  ProviderFinishReason,
  ProviderUsageUpdate,
} from "@/runtime/llm/types.ts";

type OpenAIApiMode = "chat_completions" | "responses";
interface OpenAIResponsesExtractionState {
  reasoningDeltaReceived: boolean;
}

function normalizedOpenAIModelName(model: string | undefined): string {
  return (model || "gpt-4o-mini")
    .toLowerCase()
    .replace(/^openai\//, "");
}

function isOpenAIResponsesAutoModel(model: string | undefined): boolean {
  const normalized = normalizedOpenAIModelName(model);
  if (normalized.includes("audio")) return false;

  return normalized.startsWith("gpt-5") ||
    normalized.startsWith("gpt-4.1") ||
    normalized.startsWith("gpt-4o") ||
    /^o\d(?:[-.]|$)/.test(normalized);
}

function isOpenAIReasoningModel(model: string | undefined): boolean {
  const normalized = normalizedOpenAIModelName(model);
  return normalized.startsWith("gpt-5") || /^o\d(?:[-.]|$)/.test(normalized);
}

function resolveOpenAIApiMode(config: ProviderConfig): OpenAIApiMode {
  if (config.openaiApi === "responses") return "responses";
  if (config.openaiApi === "chat_completions") return "chat_completions";
  return isOpenAIResponsesAutoModel(config.model)
    ? "responses"
    : "chat_completions";
}

function extractOpenAIChatUsage(data: any): ProviderUsageUpdate | null {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  return {
    inputTokens: typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : undefined,
    outputTokens: typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : undefined,
    reasoningTokens:
      typeof usage.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : undefined,
    cacheReadInputTokens:
      typeof usage.prompt_tokens_details?.cached_tokens === "number"
        ? usage.prompt_tokens_details.cached_tokens
        : undefined,
    totalTokens: typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : undefined,
    rawUsage: usage as Record<string, unknown>,
  };
}

function extractOpenAIResponsesUsage(data: any): ProviderUsageUpdate | null {
  const usage = data?.response?.usage ?? data?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const inputTokens = typeof usage.input_tokens === "number"
    ? usage.input_tokens
    : undefined;
  const outputTokens = typeof usage.output_tokens === "number"
    ? usage.output_tokens
    : undefined;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens:
      typeof usage.output_tokens_details?.reasoning_tokens === "number"
        ? usage.output_tokens_details.reasoning_tokens
        : undefined,
    cacheReadInputTokens:
      typeof usage.input_tokens_details?.cached_tokens === "number"
        ? usage.input_tokens_details.cached_tokens
        : undefined,
    totalTokens: typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined,
    rawUsage: usage as Record<string, unknown>,
  };
}

function extractOpenAIChatFinishReason(data: any): ProviderFinishReason | null {
  const reason = data?.choices?.[0]?.finish_reason;
  if (reason === "length") return "length";
  if (reason === "stop") return "stop";
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_calls";
  }
  if (reason === "content_filter") return "content_filter";
  return typeof reason === "string" ? "unknown" : null;
}

function extractOpenAIResponsesFinishReason(
  data: any,
): ProviderFinishReason | null {
  const status = data?.response?.status ?? data?.status;
  const reason = data?.response?.incomplete_details?.reason ??
    data?.incomplete_details?.reason;

  if (data?.type === "response.completed" || status === "completed") {
    return "stop";
  }
  if (data?.type === "response.incomplete" || status === "incomplete") {
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
    return "unknown";
  }
  if (data?.type === "response.failed" || status === "failed") {
    return "error";
  }

  return null;
}

function openAIResponsesStreamErrorStatus(code: string | undefined): number {
  if (code === "insufficient_quota" || code === "rate_limit_exceeded") {
    return 429;
  }
  if (code === "invalid_api_key") return 401;
  if (code === "permission_denied") return 403;
  return 400;
}

function throwOpenAIResponsesStreamError(data: any): never {
  const error = data?.error ?? data?.response?.error ?? {};
  const code = typeof error?.code === "string" ? error.code : undefined;
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : "OpenAI Responses stream failed";
  throw Object.assign(new Error(message), {
    status: openAIResponsesStreamErrorStatus(code),
    code,
  });
}

function openAIEndpoint(config: ProviderConfig, mode: OpenAIApiMode): string {
  const baseUrl = typeof config.baseUrl === "string" && config.baseUrl.trim()
    ? config.baseUrl.trim().replace(/\/+$/, "")
    : "https://api.openai.com/v1";
  return `${baseUrl}/${
    mode === "responses" ? "responses" : "chat/completions"
  }`;
}

function toChatCompletionsMessages(messages: ChatMessage[]): any[] {
  return messages.map((msg) => {
    if (Array.isArray(msg.content)) {
      const parts = (msg.content as ChatContentPart[]).flatMap((p) => {
        if (p.type === "text") {
          return [{ type: "text", text: p.text }];
        }
        if (p.type === "image_url" && p.image_url?.url) {
          return [{
            type: "image_url",
            image_url: { url: p.image_url.url },
          }];
        }
        if (p.type === "input_audio" && p.input_audio?.data) {
          return [{
            type: "input_audio",
            input_audio: {
              data: p.input_audio.data,
              format: p.input_audio.format || "wav",
            },
          }];
        }
        if (p.type === "file" && p.file?.file_data) {
          const data = p.file.file_data;
          if (typeof data === "string" && data.startsWith("data:")) {
            return [{ type: "image_url", image_url: { url: data } }];
          }
        }
        return [] as any[];
      });
      return { role: msg.role, content: parts } as any;
    }
    return { role: msg.role, content: msg.content } as any;
  });
}

function toResponsesRole(role: ChatMessage["role"]): string {
  if (role === "tool" || role === "tool_result") return "user";
  return role;
}

function toResponsesContent(
  content: ChatMessage["content"],
): string | any[] {
  if (typeof content === "string") return content;

  return (content as ChatContentPart[]).flatMap((part) => {
    if (part.type === "text") {
      return [{ type: "input_text", text: part.text }];
    }
    if (part.type === "image_url" && part.image_url?.url) {
      return [{
        type: "input_image",
        image_url: part.image_url.url,
      }];
    }
    if (part.type === "input_audio" && part.input_audio?.data) {
      const format = part.input_audio.format || "wav";
      return [{
        type: "input_file",
        file_data: `data:audio/${format};base64,${part.input_audio.data}`,
      }];
    }
    if (part.type === "file" && part.file?.file_data) {
      const data = part.file.file_data;
      if (typeof data !== "string" || data.length === 0) return [] as any[];
      if (data.startsWith("data:image/")) {
        return [{ type: "input_image", image_url: data }];
      }
      return [{
        type: "input_file",
        file_data: data,
      }];
    }
    return [] as any[];
  });
}

function toResponsesInput(messages: ChatMessage[]): any[] {
  return messages.map((message) => ({
    role: toResponsesRole(message.role),
    content: toResponsesContent(message.content),
  }));
}

function buildChatCompletionsBody(
  messages: ChatMessage[],
  config: ProviderConfig,
): Record<string, unknown> {
  const modelName = config.model || "gpt-4o-mini";
  const bodyConfig: Record<string, unknown> = {
    model: modelName,
    messages: toChatCompletionsMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    temperature: config.temperature || 1,
    top_p: config.topP,
    presence_penalty: config.presencePenalty,
    frequency_penalty: config.frequencyPenalty,
    stop: config.stop,
    seed: config.seed,
    user: config.user,
    reasoning_effort: config.reasoningEffort,
    verbosity: config.verbosity,
    response_format: config.responseType === "json"
      ? { type: "json_object" }
      : undefined,
  };

  const maxComp = config.maxCompletionTokens ?? config.maxTokens ?? 1000;
  if (typeof maxComp === "number") {
    bodyConfig.max_completion_tokens = maxComp;
  }

  return bodyConfig;
}

function buildResponsesBody(
  messages: ChatMessage[],
  config: ProviderConfig,
): Record<string, unknown> {
  const modelName = config.model || "gpt-4o-mini";
  const bodyConfig: Record<string, unknown> = {
    model: modelName,
    input: toResponsesInput(messages),
    stream: true,
    store: false,
    temperature: config.temperature || 1,
    top_p: config.topP,
    truncation: "disabled",
    parallel_tool_calls: false,
  };

  const maxOutput = config.maxCompletionTokens ?? config.maxTokens ?? 1000;
  if (typeof maxOutput === "number") {
    bodyConfig.max_output_tokens = maxOutput;
  }

  if (config.seed !== undefined) bodyConfig.seed = config.seed;
  if (config.user) bodyConfig.safety_identifier = config.user;

  const textConfig: Record<string, unknown> = {
    format: config.responseType === "json"
      ? { type: "json_object" }
      : { type: "text" },
  };
  if (
    config.verbosity === "low" ||
    config.verbosity === "medium" ||
    config.verbosity === "high"
  ) {
    textConfig.verbosity = config.verbosity;
  }
  bodyConfig.text = textConfig;

  if (isOpenAIReasoningModel(modelName)) {
    const reasoning: Record<string, unknown> = {};
    if (config.reasoningEffort) reasoning.effort = config.reasoningEffort;
    if (config.openaiReasoningSummary !== false) {
      reasoning.summary = config.openaiReasoningSummary ?? "auto";
    }
    if (Object.keys(reasoning).length > 0) {
      bodyConfig.reasoning = reasoning;
    }
  }

  return bodyConfig;
}

function extractOpenAIChatContent(data: any): ExtractedPart[] | null {
  const delta = data?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return null;

  const parts: ExtractedPart[] = [];

  const reasoning = delta.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    parts.push({ text: reasoning, isReasoning: true });
  }

  if (typeof delta.content === "string" && delta.content.length > 0) {
    parts.push({ text: delta.content });
  }

  return parts.length > 0 ? parts : null;
}

function extractOpenAIResponsesContent(
  data: any,
  state?: OpenAIResponsesExtractionState,
): ExtractedPart[] | null {
  const parts: ExtractedPart[] = [];
  const type = data?.type;
  const delta = data?.delta;

  if (type === "error" || type === "response.failed") {
    throwOpenAIResponsesStreamError(data);
  }

  if (
    (type === "response.output_text.delta" ||
      type === "response.refusal.delta") &&
    typeof delta === "string" &&
    delta.length > 0
  ) {
    parts.push({ text: delta });
  }

  if (
    (type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta") &&
    typeof delta === "string" &&
    delta.length > 0
  ) {
    if (state) state.reasoningDeltaReceived = true;
    parts.push({ text: delta, isReasoning: true });
  }

  const reasoningItems = !state?.reasoningDeltaReceived &&
      Array.isArray(data?.response?.output)
    ? data.response.output
    : !state?.reasoningDeltaReceived && data?.item?.type === "reasoning"
    ? [data.item]
    : [];
  for (const item of reasoningItems) {
    if (!item || item.type !== "reasoning") continue;
    const summary = Array.isArray(item.summary) ? item.summary : [];
    for (const entry of summary) {
      if (entry?.type !== "summary_text") continue;
      if (typeof entry.text === "string" && entry.text.length > 0) {
        parts.push({ text: entry.text, isReasoning: true });
      }
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const entry of content) {
      if (entry?.type !== "reasoning_text") continue;
      if (typeof entry.text === "string" && entry.text.length > 0) {
        parts.push({ text: entry.text, isReasoning: true });
      }
    }
  }

  return parts.length > 0 ? parts : null;
}

export const openaiProvider: ProviderFactory = (config: ProviderConfig) => {
  const apiMode = resolveOpenAIApiMode(config);
  const responsesExtractionState: OpenAIResponsesExtractionState = {
    reasoningDeltaReceived: false,
  };

  return {
    endpoint: openAIEndpoint(config, apiMode),

    headers: (config: ProviderConfig) => ({
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    }),

    body: (messages: ChatMessage[], config: ProviderConfig) => {
      return apiMode === "responses"
        ? buildResponsesBody(messages, config)
        : buildChatCompletionsBody(messages, config);
    },

    extractContent: (data: any): ExtractedPart[] | null => {
      return apiMode === "responses"
        ? extractOpenAIResponsesContent(data, responsesExtractionState)
        : extractOpenAIChatContent(data);
    },

    extractUsage: apiMode === "responses"
      ? extractOpenAIResponsesUsage
      : extractOpenAIChatUsage,
    extractFinishReason: apiMode === "responses"
      ? extractOpenAIResponsesFinishReason
      : extractOpenAIChatFinishReason,
  };
};
