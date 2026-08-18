import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import {
  definePlugin,
  type CopilotzPlugin,
  type Processor,
} from "@copilotz/copilotz/plugins";
import { corePluginManifest } from "./manifest.ts";
import { threadMessageFeature } from "./resources/features/thread-message.ts";
import { coreLlmResources } from "./resources/llm/index.ts";
import {
  llmAttemptCollection,
  messageCollection,
  participantCollection,
  streamCollection,
  threadCollection,
  toolExecutionCollection,
} from "./resources/collections/index.ts";
import {
  askTool,
  completeAskProcessor,
  failAskProcessor,
} from "./resources/processors/ask.ts";
import {
  executeTextAttemptProcessor,
  executeToolProcessor,
  messageRouterProcessor,
  projectTextResultProcessor,
  projectToolResultProcessor,
} from "./resources/processors/text.ts";

const processors: readonly Processor<CopilotzProcessorContext>[] = Object
  .freeze([
    messageRouterProcessor,
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
  streamCollection,
]);

/** Collections without text/ask processors. Tests that must not run core routing. */
export const coreCollectionsPlugin: CopilotzPlugin = definePlugin({
  manifest: {
    id: "@copilotz/core-collections",
    version: corePluginManifest.version,
    provides: {
      collections: corePluginManifest.provides.collections,
      features: corePluginManifest.provides.features,
    },
  },
  resources: {
    collections: [...collections],
    features: [threadMessageFeature],
  },
});

/** Static core plugin: collections, text/ask processors, llm adapters, ask tool, thread-message feature. */
export const corePlugin: CopilotzPlugin = definePlugin({
  manifest: corePluginManifest,
  resources: {
    collections: [...collections],
    processors,
    llm: [...coreLlmResources],
    tools: [askTool],
    features: [threadMessageFeature],
  },
});
