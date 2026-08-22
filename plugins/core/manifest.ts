import type { PluginManifest } from "@copilotz/copilotz/plugins";

export const corePluginManifest: PluginManifest = Object.freeze({
  id: "@copilotz/core",
  version: "0.61.0",
  provides: Object.freeze({
    collections: Object.freeze([
      "participant",
      "thread",
      "message",
    ]),
    processors: Object.freeze([
      "copilotz.core.message-to-text-attempt",
      "copilotz.core.message-input",
      "copilotz.core.project-text-result",
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
    features: Object.freeze([
      "copilotz.core.thread-message",
      "copilotz.core.llm",
      "copilotz.core.tool",
      "copilotz.core.tool-batch",
      "copilotz.core.thread",
      "copilotz.core.message",
    ]),
  }),
});
