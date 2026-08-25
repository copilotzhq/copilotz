/** Exposes Core conversation and Tool-plan Collections. @module */

export { messageCollection, messageRevisionFrom } from "./message/index.ts";
export type { MessageRecord } from "./message/index.ts";
export { participantCollection } from "./participant/index.ts";
export { threadCollection } from "./thread/index.ts";
export { toolPlanCollection } from "./tool-plan/index.ts";
export { toolPlanStageResultCollection } from "./tool-plan-stage-result/index.ts";
export type { MessageBranch, MessageRevision } from "../internal/contracts.ts";
export { projectActiveMessageBranch } from "../internal/projections.ts";

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
