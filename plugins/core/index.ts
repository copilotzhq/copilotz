/** Exposes Core's public semantic and conversation surface. @module */

export {
  CORE_PLUGIN_ID,
  CORE_PLUGIN_VERSION,
  coreActions,
  coreCollections,
  corePlugin,
  coreProcessors,
} from "./plugin.ts";
export { ASK_ACTION_ID, askAction } from "./actions/ask/index.ts";
export type { AskInput, AskOutput } from "./actions/ask/index.ts";
export {
  CORE_COLLECTION_NAMES,
  messageCollection,
  messageRevisionFrom,
  participantCollection,
  threadCollection,
} from "./collections/index.ts";
export type {
  ConversationMessage,
  ConversationThread,
  MessageBranch,
  MessageRevision,
  Participant,
  ParticipantInput,
  ParticipantType,
} from "./shared/contracts.ts";
export type { MessageRecord } from "./collections/index.ts";
export {
  listThreadMessageRecords,
  loadMessageRecord,
  loadParticipantRecord,
  loadThreadRecord,
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
  projectActiveMessageBranch,
} from "./shared/projections.ts";
export * from "./shared/thread-metadata.ts";
export * from "./shared/workflow-metadata.ts";
export * from "./actions/index.ts";
export * from "./authoring/index.ts";
export * from "./resources/index.ts";

export {
  spaceAttachmentCollection,
  spaceAttachmentId,
  spaceCollection,
} from "./collections/index.ts";

export * from "./authoring/define-tool/generated.ts";
export * from "./shared/tools/lifecycle-json.ts";
export type { CoreResources } from "./shared/runtime-context.ts";
export { loadCoreThreadMessageSnapshot } from "./shared/helpers.ts";
export { buildLlmTranscript } from "./shared/agents/transcript.ts";
export { prepareLlmTranscript } from "./shared/agents/prepared-transcript.ts";

export * from "./shared/events/index.ts";
export * from "./processors/message-input/input/index.ts";
export * from "./shared/capabilities/grants.ts";
export * from "./shared/capabilities/selection.ts";

export {
  collectContextContributions,
  type CollectedContextContribution,
} from "./shared/contributions.ts";

export * from "./actions/run-goal/index.ts";
