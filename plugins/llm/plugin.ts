/** Composition root for the provider-neutral LLM plugin. @module */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { callLlmAction } from "./actions/call-llm/index.ts";

export const LLM_PLUGIN_ID = "@copilotz/llm";
export const LLM_PLUGIN_VERSION = "0.63.7";

type EmptyMap = Readonly<Record<never, never>>;
type LlmActions = Readonly<{ callLlm: typeof callLlmAction }>;

/** Provider-neutral lifecycle and built-in drivers; installs no configured Model. */
export const llmPlugin: CopilotzPlugin<
  typeof LLM_PLUGIN_ID,
  typeof LLM_PLUGIN_VERSION,
  readonly [],
  EmptyMap,
  LlmActions,
  EmptyMap,
  EmptyMap,
  EmptyMap
> = definePlugin({
  id: LLM_PLUGIN_ID,
  version: LLM_PLUGIN_VERSION,
  actions: { callLlm: callLlmAction },
});
