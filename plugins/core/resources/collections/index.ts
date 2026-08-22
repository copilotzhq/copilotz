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

export const CORE_COLLECTION_NAMES: readonly [
  "participant",
  "thread",
  "message",
] = Object.freeze([
  "participant",
  "thread",
  "message",
]);
