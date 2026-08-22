import { llmFeature } from "./resources/features/llm.ts";
import { toolBatchFeature, toolFeature } from "./resources/features/tool.ts";
import { messageFeature } from "./resources/features/message.ts";
import { threadFeature } from "./resources/features/thread.ts";
import { threadMessageFeature } from "./resources/features/thread-message.ts";

export { corePluginManifest } from "./manifest.ts";
export { coreCollectionsPlugin, corePlugin } from "./plugin.ts";
export {
  TOOL_BATCH_FEATURE_ID,
  TOOL_FEATURE_ID,
  toolBatchFeature,
  toolFeature,
} from "./resources/features/tool.ts";
export {
  core,
  CORE_MESSAGE_INPUT_EVENT,
  message,
} from "./resources/inputs/index.ts";
export type {
  CoreMessageInput,
  CoreMessageInputEnvelope,
} from "./resources/inputs/index.ts";
export {
  THREAD_MESSAGE_FEATURE_ID,
  threadMessageFeature,
} from "./resources/features/thread-message.ts";
export { LLM_FEATURE_ID, llmFeature } from "./resources/features/llm.ts";
export {
  MESSAGE_FEATURE_ID,
  messageFeature,
} from "./resources/features/message.ts";
export {
  THREAD_FEATURE_ID,
  threadFeature,
} from "./resources/features/thread.ts";
export {
  CORE_COLLECTION_NAMES,
  messageCollection,
  messageRevisionFrom,
  participantCollection,
  projectActiveMessageBranch,
  threadCollection,
} from "./resources/collections/index.ts";
export type {
  MessageBranch,
  MessageRecord,
  MessageRevision,
} from "./resources/collections/index.ts";

/** Consumer-local aliases for tests and host FeatureContext construction. */
export type CoreFeatureAliases = Readonly<{
  thread: typeof threadFeature;
  threadMessage: typeof threadMessageFeature;
  message: typeof messageFeature;
  llm: typeof llmFeature;
  tool: typeof toolFeature;
  toolBatch: typeof toolBatchFeature;
}>;

export const coreFeatureAliases: CoreFeatureAliases = Object.freeze({
  thread: threadFeature,
  threadMessage: threadMessageFeature,
  message: messageFeature,
  llm: llmFeature,
  tool: toolFeature,
  toolBatch: toolBatchFeature,
});
