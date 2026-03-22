import type { ExtractedPart, ProviderConfig } from "./types.ts";

/**
 * Gemini returns an error if `thinkingConfig` is set for models that do not support thinking.
 * Keep this conservative; callers can force thoughts via `ProviderConfig.geminiThinkingConfig`.
 */
export function geminiModelSupportsThinkingConfig(model: string): boolean {
  const m = model.toLowerCase().replace(/^models\//, "");
  if (/^gemini-1\./.test(m)) return false;
  if (/^gemini-2\.0/.test(m)) return false;
  if (/^gemini-2\.5/.test(m)) return true;
  if (/^gemini-3/.test(m)) return true;
  if (/gemini-exp/.test(m)) return true;
  return false;
}

export function shouldStreamGeminiThoughts(
  config: ProviderConfig,
  model: string,
): boolean {
  if (config.outputReasoning === false) return false;
  const g = config.geminiThinkingConfig;
  if (g?.includeThoughts === false) return false;
  if (g?.includeThoughts === true) return true;
  return geminiModelSupportsThinkingConfig(model);
}

/**
 * Map parsed Chat Completions SSE JSON → text / reasoning parts.
 *
 * Documented Chat Completions stream fields for reasoning models (o-series, gpt-5):
 * - `delta.reasoning_content`: raw reasoning tokens (the closest to chain-of-thought OpenAI exposes)
 * - `delta.content`: the visible answer tokens (always a string in Chat Completions)
 */
export function extractOpenAiChatStreamParts(data: any): ExtractedPart[] | null {
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
