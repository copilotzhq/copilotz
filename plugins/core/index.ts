/** Exposes Core's public semantic and conversation surface. @module */

export { agentInstructionBase, defineAgent } from "./resources/agent/index.ts";
export type {
  AgentCapabilities,
  AgentCapabilitySelection,
  AgentInstructionContext,
  AgentInstructionExecution,
  AgentInstructionResolution,
  AgentInstructionResolver,
  AgentModels,
  AgentModelSelection,
  AgentResource,
} from "./resources/agent/index.ts";
export type {
  ReasoningHistoryInclude,
  ReasoningHistoryOptions,
} from "./authoring/reasoning.ts";
export {
  CORE_PLUGIN_ID,
  CORE_PLUGIN_VERSION,
  coreActions,
  coreCollections,
  corePlugin,
  coreProcessors,
} from "./plugin.ts";
export {
  ADD_THREAD_PARTICIPANT_ACTION_ID,
  addThreadParticipantAction,
  CREATE_THREAD_ACTION_ID,
  createThreadAction,
  DELETE_THREAD_MESSAGES_ACTION_ID,
  deleteThreadMessagesAction,
} from "./actions/index.ts";
export {
  CREATE_THREAD_MESSAGE_ACTION_ID,
  createThreadMessageAction,
} from "./actions/index.ts";
export {
  REVISE_MESSAGE_ACTION_ID,
  reviseMessageAction,
} from "./actions/index.ts";
export { ASK_ACTION_ID, askAction } from "./actions/ask/index.ts";
export type { AskInput, AskOutput } from "./actions/ask/index.ts";
export { askTool } from "./resources/tools/ask/index.ts";
export { core, CORE_MESSAGE_INPUT_EVENT, message } from "./authoring/index.ts";
export type {
  CoreMessageInput,
  CoreMessageInputEnvelope,
} from "./authoring/index.ts";
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
export * from "./authoring/capabilities/index.ts";
export * from "./resources/context/index.ts";
export * from "./resources/prompt-instructions/index.ts";
export * from "./shared/thread-metadata.ts";
export * from "./shared/workflow-metadata.ts";
export * from "./actions/index.ts";
export * from "./authoring/index.ts";
export * from "./resources/index.ts";

export { SPACES_ACTION_ID, spacesAction } from "./actions/spaces/index.ts";
export {
  spaceAttachmentCollection,
  spaceAttachmentId,
  spaceCollection,
} from "./collections/index.ts";

export type { SpaceInput, SpaceResult } from "./actions/spaces/index.ts";

export * from "./shared/tools/generated.ts";
export * from "./shared/tools/lifecycle-json.ts";
export type { CoreResources } from "./shared/runtime-context.ts";
export { loadCoreThreadMessageSnapshot } from "./shared/helpers.ts";
export { buildLlmTranscript } from "./shared/agents/transcript.ts";
export { prepareLlmTranscript } from "./shared/agents/prepared-transcript.ts";
