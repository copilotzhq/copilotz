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
  spacesAction,
} from "./actions/index.ts";
import {
  messageCollection,
  participantCollection,
  spaceAttachmentCollection,
  spaceCollection,
  threadCollection,
  toolPlanCollection,
  toolPlanStageResultCollection,
} from "./collections/index.ts";
import { messageInputProcessor } from "./processors/index.ts";
import { askAction } from "../core/actions/ask/index.ts";

const VERSION = "0.65.1";

type CoreCollectionsProcessors = Readonly<{
  messageInput: typeof messageInputProcessor;
}>;

type EmptyPluginNamespaces = Readonly<Record<never, never>>;

export type CoreCollections = Readonly<{
  space: typeof spaceCollection;
  spaceAttachment: typeof spaceAttachmentCollection;
  participant: typeof participantCollection;
  thread: typeof threadCollection;
  message: typeof messageCollection;
  toolPlan: typeof toolPlanCollection;
  toolPlanStageResult: typeof toolPlanStageResultCollection;
}>;

export const coreCollections: CoreCollections = {
  participant: participantCollection,
  thread: threadCollection,
  message: messageCollection,
  toolPlan: toolPlanCollection,
  toolPlanStageResult: toolPlanStageResultCollection,
  space: spaceCollection,
  spaceAttachment: spaceAttachmentCollection,
};

export type CoreCollectionActions = Readonly<{
  spaces: typeof spacesAction;
  createThread: typeof createThreadAction;
  addThreadParticipant: typeof addThreadParticipantAction;
  deleteThreadMessages: typeof deleteThreadMessagesAction;
  reviseMessage: typeof reviseMessageAction;
  createThreadMessage: typeof createThreadMessageAction;
  ask: typeof askAction;
}>;

export const coreCollectionActions: CoreCollectionActions = {
  spaces: spacesAction,
  createThread: createThreadAction,
  addThreadParticipant: addThreadParticipantAction,
  deleteThreadMessages: deleteThreadMessagesAction,
  reviseMessage: reviseMessageAction,
  createThreadMessage: createThreadMessageAction,
  ask: askAction,
};

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
