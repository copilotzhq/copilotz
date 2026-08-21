export { llmAttemptCollection } from "./llm-attempt.ts";
export {
  messageCollection,
  messageRevisionFrom,
  projectActiveMessageBranch,
} from "./message.ts";
export type {
  MessageBranch,
  MessageRecord,
  MessageRevision,
} from "./message.ts";
export { participantCollection } from "./participant.ts";
export { threadCollection } from "./thread.ts";
export { toolExecutionCollection } from "./tool-execution.ts";

export const CORE_COLLECTION_NAMES: readonly [
  "participant",
  "thread",
  "message",
  "llm_attempt",
  "tool_execution",
] = Object.freeze([
  "participant",
  "thread",
  "message",
  "llm_attempt",
  "tool_execution",
]);
