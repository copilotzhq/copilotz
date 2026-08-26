/**
 * Composes Core storage, LLM routing, Ask, and Tool-plan semantics.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { llmPlugin } from "@copilotz/copilotz/llm";
import {
  coreCollectionActions,
  coreCollections,
  coreCollectionsPlugin,
  messageInputProcessor,
} from "../core-collections/index.ts";
import {
  completeAskProcessor,
  failAskProcessor,
  messageRouterProcessor,
  projectTextResultProcessor,
  projectToolResultProcessor,
  toolPlanCoordinatorProcessor,
} from "./processors/index.ts";
import { askTool } from "./resources/ask-tool/index.ts";

export const CORE_PLUGIN_ID = "@copilotz/core";
export const CORE_PLUGIN_VERSION = "0.63.3";

export type CoreCollections = typeof coreCollections;
export type CoreActions = typeof coreCollectionActions;

export const coreActions = coreCollectionActions;

export type CoreProcessors = Readonly<{
  messageRouter: typeof messageRouterProcessor;
  messageInput: typeof messageInputProcessor;
  projectTextResult: typeof projectTextResultProcessor;
  projectToolResult: typeof projectToolResultProcessor;
  completeAsk: typeof completeAskProcessor;
  failAsk: typeof failAskProcessor;
  toolPlanCoordinator: typeof toolPlanCoordinatorProcessor;
}>;

type CorePluginResources = Readonly<{
  tools: Readonly<{ ask: typeof askTool }>;
}>;

type EmptyPluginNamespaces = Readonly<Record<never, never>>;

export const coreProcessors: CoreProcessors = Object.freeze({
  messageRouter: messageRouterProcessor,
  messageInput: messageInputProcessor,
  projectTextResult: projectTextResultProcessor,
  projectToolResult: projectToolResultProcessor,
  completeAsk: completeAskProcessor,
  failAsk: failAskProcessor,
  toolPlanCoordinator: toolPlanCoordinatorProcessor,
});

/** The minimum semantic plugin for an end-to-end multi-provider agent. */
export const corePlugin: CopilotzPlugin<
  typeof CORE_PLUGIN_ID,
  typeof CORE_PLUGIN_VERSION,
  readonly [typeof llmPlugin],
  CoreCollections,
  CoreActions,
  CoreProcessors,
  CorePluginResources,
  EmptyPluginNamespaces
> = definePlugin({
  id: CORE_PLUGIN_ID,
  version: CORE_PLUGIN_VERSION,
  plugins: [llmPlugin],
  collections: coreCollections,
  actions: coreActions,
  processors: coreProcessors,
  resources: { tools: { ask: askTool } },
});

export { coreCollections, coreCollectionsPlugin };
