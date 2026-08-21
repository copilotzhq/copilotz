import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import {
  type CopilotzPlugin,
  definePlugin,
  type Processor,
} from "@copilotz/copilotz/plugins";
import { corePluginManifest } from "./manifest.ts";
import { threadMessageFeature } from "./resources/features/thread-message.ts";
import { llmAttemptFeature } from "./resources/features/llm-attempt.ts";
import { toolExecutionFeature } from "./resources/features/tool-execution.ts";
import { threadFeature } from "./resources/features/thread.ts";
import { messageFeature } from "./resources/features/message.ts";
import { coreLlmResources } from "./resources/llm/index.ts";
import {
  llmAttemptCollection,
  messageCollection,
  participantCollection,
  threadCollection,
  toolExecutionCollection,
} from "./resources/collections/index.ts";
import {
  completeAskProcessor,
  executeTextAttemptProcessor,
  executeToolProcessor,
  failAskProcessor,
  messageInputProcessor,
  messageRouterProcessor,
  projectTextResultProcessor,
  projectToolResultProcessor,
} from "./resources/processors/index.ts";
import { askTool } from "./resources/tools/ask.ts";

const processors: readonly Processor<CopilotzProcessorContext>[] = Object
  .freeze([
    messageRouterProcessor,
    messageInputProcessor,
    executeTextAttemptProcessor,
    executeToolProcessor,
    projectTextResultProcessor,
    projectToolResultProcessor,
    completeAskProcessor,
    failAskProcessor,
  ]);

const collections = Object.freeze([
  participantCollection,
  threadCollection,
  messageCollection,
  llmAttemptCollection,
  toolExecutionCollection,
]);

const features = Object.freeze([
  threadMessageFeature,
  llmAttemptFeature,
  toolExecutionFeature,
  threadFeature,
  messageFeature,
]);

/** Collections without text/ask processors. Tests that must not run core routing. */
export const coreCollectionsPlugin: CopilotzPlugin = definePlugin({
  id: "@copilotz/core-collections",
  version: corePluginManifest.version,
  collections: [...collections],
  processors: [messageInputProcessor],
  features: [...features],
});

/** Static core plugin: collections, text/ask processors, llm adapters, ask tool, thread-message feature. */
export const corePlugin: CopilotzPlugin = definePlugin({
  id: corePluginManifest.id,
  version: corePluginManifest.version,
  collections: [...collections],
  processors,
  llm: [...coreLlmResources],
  tools: [askTool],
  features: [...features],
});
