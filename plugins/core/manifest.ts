import type { PluginManifest } from "@copilotz/copilotz/plugins";

export const corePluginManifest: PluginManifest = Object.freeze({
  id: "@copilotz/core",
  version: "0.61.0",
  provides: Object.freeze({
    collections: Object.freeze([
      "participant",
      "thread",
      "message",
      "llm_attempt",
      "tool_execution",
      "stream",
    ]),
    processors: Object.freeze([
      "copilotz.core.message-to-text-attempt",
      "copilotz.core.execute-text-attempt",
      "copilotz.core.project-text-result",
      "copilotz.core.execute-tool",
      "copilotz.core.project-tool-result",
      "copilotz.core.complete-agent-ask",
      "copilotz.core.fail-agent-ask",
    ]),
    llm: Object.freeze([
      "openai",
      "anthropic",
      "gemini",
      "groq",
      "deepseek",
      "ollama",
      "minimax",
    ]),
    tools: Object.freeze(["ask"]),
    features: Object.freeze(["copilotz.core.thread-message"]),
  }),
});
