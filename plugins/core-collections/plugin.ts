/**
 * Composes Core's durable conversation storage boundary.
 *
 * @module
 */

import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  addThreadParticipantAction,
  createThreadAction,
  createThreadMessageAction,
  deleteThreadMessagesAction,
  reviseMessageAction,
} from "./actions/index.ts";
import {
  messageCollection,
  participantCollection,
  threadCollection,
  toolPlanCollection,
  toolPlanStageResultCollection,
} from "./collections/index.ts";
import { messageInputProcessor } from "./processors/index.ts";
import { askAction } from "../core/actions/ask/index.ts";

const VERSION = "0.63.4";

type CoreCollectionsProcessors = Readonly<{
  messageInput: typeof messageInputProcessor;
}>;

type EmptyPluginNamespaces = Readonly<Record<never, never>>;

export type CoreCollections = Readonly<{
  participant: typeof participantCollection;
  thread: typeof threadCollection;
  message: typeof messageCollection;
  toolPlan: typeof toolPlanCollection;
  toolPlanStageResult: typeof toolPlanStageResultCollection;
}>;

export const coreCollections: CoreCollections = Object.freeze({
  participant: participantCollection,
  thread: threadCollection,
  message: messageCollection,
  toolPlan: toolPlanCollection,
  toolPlanStageResult: toolPlanStageResultCollection,
});

export type CoreCollectionActions = Readonly<{
  createThread: typeof createThreadAction;
  addThreadParticipant: typeof addThreadParticipantAction;
  deleteThreadMessages: typeof deleteThreadMessagesAction;
  reviseMessage: typeof reviseMessageAction;
  createThreadMessage: typeof createThreadMessageAction;
  ask: typeof askAction;
}>;

export const coreCollectionActions: CoreCollectionActions = Object.freeze({
  createThread: createThreadAction,
  addThreadParticipant: addThreadParticipantAction,
  deleteThreadMessages: deleteThreadMessagesAction,
  reviseMessage: reviseMessageAction,
  createThreadMessage: createThreadMessageAction,
  ask: askAction,
});

/** Collections and Actions without Core's semantic routing processors. */
export const coreCollectionsPlugin: CopilotzPlugin<
  "@copilotz/core-collections",
  typeof VERSION,
  readonly [],
  CoreCollections,
  CoreCollectionActions,
  CoreCollectionsProcessors,
  EmptyPluginNamespaces,
  EmptyPluginNamespaces
> = definePlugin({
  id: "@copilotz/core-collections",
  version: VERSION,
  collections: coreCollections,
  actions: coreCollectionActions,
  processors: { messageInput: messageInputProcessor },
});
