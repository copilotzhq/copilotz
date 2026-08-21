import { llmAttemptFeature } from "./resources/features/llm-attempt.ts";
import { messageFeature } from "./resources/features/message.ts";
import { threadFeature } from "./resources/features/thread.ts";
import { threadMessageFeature } from "./resources/features/thread-message.ts";
import { toolExecutionFeature } from "./resources/features/tool-execution.ts";

export { corePluginManifest } from "./manifest.ts";
export { coreCollectionsPlugin, corePlugin } from "./plugin.ts";
export {
  THREAD_MESSAGE_FEATURE_ID,
  threadMessageFeature,
} from "./resources/features/thread-message.ts";
export {
  LLM_ATTEMPT_FEATURE_ID,
  llmAttemptFeature,
} from "./resources/features/llm-attempt.ts";
export {
  MESSAGE_FEATURE_ID,
  messageFeature,
} from "./resources/features/message.ts";
export {
  THREAD_FEATURE_ID,
  threadFeature,
} from "./resources/features/thread.ts";
export {
  TOOL_EXECUTION_FEATURE_ID,
  toolExecutionFeature,
} from "./resources/features/tool-execution.ts";
export {
  CORE_COLLECTION_NAMES,
  llmAttemptCollection,
  messageCollection,
  messageRevisionFrom,
  participantCollection,
  projectActiveMessageBranch,
  streamCollection,
  threadCollection,
  toolExecutionCollection,
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
  llmAttempt: typeof llmAttemptFeature;
  toolExecution: typeof toolExecutionFeature;
}>;

export const coreFeatureAliases: CoreFeatureAliases = Object.freeze({
  thread: threadFeature,
  threadMessage: threadMessageFeature,
  message: messageFeature,
  llmAttempt: llmAttemptFeature,
  toolExecution: toolExecutionFeature,
});
