import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import { llmPlugin } from "@copilotz/copilotz/llm";
import {
  messageCollection,
  participantCollection,
  threadCollection,
} from "./resources/collections/index.ts";
import {
  completeAskProcessor,
  failAskProcessor,
  messageInputProcessor,
  messageRouterProcessor,
  projectTextResultProcessor,
  projectToolResultProcessor,
} from "./resources/processors/index.ts";
import { createThreadMessageAction } from "./resources/actions/thread-message.ts";
import {
  addThreadParticipantAction,
  createThreadAction,
  deleteThreadMessagesAction,
} from "./resources/actions/thread.ts";
import { reviseMessageAction } from "./resources/actions/message.ts";
import { askAction, askTool } from "./resources/tools/ask.ts";

export const CORE_PLUGIN_ID = "@copilotz/core";
export const CORE_PLUGIN_VERSION = "0.62.0";

export type CoreCollections = Readonly<{
  participant: typeof participantCollection;
  thread: typeof threadCollection;
  message: typeof messageCollection;
}>;

export type CoreActions = Readonly<{
  createThread: typeof createThreadAction;
  addThreadParticipant: typeof addThreadParticipantAction;
  deleteThreadMessages: typeof deleteThreadMessagesAction;
  reviseMessage: typeof reviseMessageAction;
  createThreadMessage: typeof createThreadMessageAction;
  ask: typeof askAction;
}>;

export type CoreProcessors = Readonly<{
  messageRouter: typeof messageRouterProcessor;
  messageInput: typeof messageInputProcessor;
  projectTextResult: typeof projectTextResultProcessor;
  projectToolResult: typeof projectToolResultProcessor;
  completeAsk: typeof completeAskProcessor;
  failAsk: typeof failAskProcessor;
}>;

type CoreCollectionsProcessors = Readonly<{
  messageInput: typeof messageInputProcessor;
}>;

type CorePluginResources = Readonly<{
  tools: Readonly<{ ask: typeof askTool }>;
}>;

type EmptyPluginNamespaces = Readonly<Record<never, never>>;

export const coreCollections: CoreCollections = Object.freeze({
  participant: participantCollection,
  thread: threadCollection,
  message: messageCollection,
});

export const coreActions: CoreActions = Object.freeze({
  createThread: createThreadAction,
  addThreadParticipant: addThreadParticipantAction,
  deleteThreadMessages: deleteThreadMessagesAction,
  reviseMessage: reviseMessageAction,
  createThreadMessage: createThreadMessageAction,
  ask: askAction,
});

export const coreProcessors: CoreProcessors = Object.freeze({
  messageRouter: messageRouterProcessor,
  messageInput: messageInputProcessor,
  projectTextResult: projectTextResultProcessor,
  projectToolResult: projectToolResultProcessor,
  completeAsk: completeAskProcessor,
  failAsk: failAskProcessor,
});

/** Collections and Actions without Core's semantic routing processors. */
export const coreCollectionsPlugin: CopilotzPlugin<
  "@copilotz/core-collections",
  typeof CORE_PLUGIN_VERSION,
  readonly [],
  CoreCollections,
  CoreActions,
  CoreCollectionsProcessors,
  EmptyPluginNamespaces,
  EmptyPluginNamespaces
> = definePlugin({
  id: "@copilotz/core-collections",
  version: CORE_PLUGIN_VERSION,
  collections: coreCollections,
  actions: coreActions,
  processors: { messageInput: messageInputProcessor },
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
