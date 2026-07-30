import type { ProviderConfig } from "@/runtime/llm/types.ts";

export type OpenAIApiMode = "chat_completions" | "responses";

function normalizedOpenAIModelName(model: string | undefined): string {
  return (model || "gpt-4o-mini")
    .toLowerCase()
    .replace(/^openai\//, "");
}

/** OpenAI explicit prompt-cache breakpoints are available on GPT-5.6+. */
export function supportsOpenAIExplicitPromptCaching(
  model: string | undefined,
): boolean {
  const normalized = normalizedOpenAIModelName(model);
  const version = /^gpt-(\d+)\.(\d+)(?:-|$)/.exec(normalized);
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 5 || (major === 5 && minor >= 6);
}

export function isOpenAIResponsesAutoModel(model: string | undefined): boolean {
  const normalized = normalizedOpenAIModelName(model);
  if (normalized.includes("audio")) return false;

  return normalized.startsWith("gpt-5") ||
    normalized.startsWith("gpt-4.1") ||
    normalized.startsWith("gpt-4o") ||
    /^o\d(?:[-.]|$)/.test(normalized);
}

export function isOpenAIReasoningModel(model: string | undefined): boolean {
  const normalized = normalizedOpenAIModelName(model);
  return normalized.startsWith("gpt-5") || /^o\d(?:[-.]|$)/.test(normalized);
}

export function resolveOpenAIApiMode(
  config: Pick<ProviderConfig, "model" | "openaiApi">,
): OpenAIApiMode {
  if (config.openaiApi === "responses") return "responses";
  if (config.openaiApi === "chat_completions") return "chat_completions";
  return isOpenAIResponsesAutoModel(config.model)
    ? "responses"
    : "chat_completions";
}
