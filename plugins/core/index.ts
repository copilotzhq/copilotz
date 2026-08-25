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
} from "./internal/reasoning.ts";
export {
  CORE_PLUGIN_ID,
  CORE_PLUGIN_VERSION,
  coreActions,
  coreCollections,
  coreCollectionsPlugin,
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
} from "../core-collections/actions/index.ts";
export {
  CREATE_THREAD_MESSAGE_ACTION_ID,
  createThreadMessageAction,
} from "../core-collections/actions/index.ts";
export {
  REVISE_MESSAGE_ACTION_ID,
  reviseMessageAction,
} from "../core-collections/actions/index.ts";
export { ASK_ACTION_ID, askAction } from "./actions/ask/index.ts";
export type { AskInput, AskOutput } from "./actions/ask/index.ts";
export { askTool } from "./resources/ask-tool/index.ts";
export {
  core,
  CORE_MESSAGE_INPUT_EVENT,
  message,
} from "../core-collections/authoring/index.ts";
export type {
  CoreMessageInput,
  CoreMessageInputEnvelope,
} from "../core-collections/authoring/index.ts";
export {
  CORE_COLLECTION_NAMES,
  messageCollection,
  messageRevisionFrom,
  participantCollection,
  threadCollection,
} from "../core-collections/collections/index.ts";
export type {
  ConversationMessage,
  ConversationThread,
  MessageBranch,
  MessageRevision,
  Participant,
  ParticipantInput,
  ParticipantType,
} from "../core-collections/internal/contracts.ts";
export type { MessageRecord } from "../core-collections/collections/index.ts";
export {
  listThreadMessageRecords,
  loadMessageRecord,
  loadParticipantRecord,
  loadThreadRecord,
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
  projectActiveMessageBranch,
} from "../core-collections/internal/projections.ts";
export * from "./internal/capabilities/index.ts";
export * from "./resources/context/index.ts";
export * from "./internal/thread-metadata.ts";
export * from "./internal/workflow-metadata.ts";
export * from "./actions/index.ts";
export * from "./authoring/index.ts";
export * from "./resources/index.ts";
