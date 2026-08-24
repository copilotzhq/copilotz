export { messageCollection, messageRevisionFrom } from "./message.ts";
export type { MessageRecord } from "./message.ts";
export type { MessageBranch, MessageRevision } from "../../contracts.ts";
export { projectActiveMessageBranch } from "../../projections.ts";
export { participantCollection } from "./participant.ts";
export { threadCollection } from "./thread.ts";
export {
  toolPlanCollection,
  toolPlanStageResultCollection,
} from "./tool-plan.ts";

export const CORE_COLLECTION_NAMES: readonly [
  "participant",
  "thread",
  "message",
  "toolPlan",
  "toolPlanStageResult",
] = Object.freeze([
  "participant",
  "thread",
  "message",
  "toolPlan",
  "toolPlanStageResult",
]);
