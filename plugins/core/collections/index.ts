/** Exposes Core conversation and Tool-plan Collections. @module */

export { messageCollection, messageRevisionFrom } from "./message/index.ts";
export type { MessageRecord } from "./message/index.ts";
export { participantCollection } from "./participant/index.ts";
export { threadCollection } from "./thread/index.ts";
export { toolPlanCollection } from "./tool-plan/index.ts";
export { toolPlanBranchCollection } from "./tool-plan-branch/index.ts";
export { toolPlanStageResultCollection } from "./tool-plan-stage-result/index.ts";
export type { MessageBranch, MessageRevision } from "../shared/contracts.ts";
export { projectActiveMessageBranch } from "../shared/projections.ts";

export const CORE_COLLECTION_NAMES = [
  "participant",
  "thread",
  "message",
  "toolPlan",
  "toolPlanBranch",
  "toolPlanStageResult",
  "space",
  "spaceAttachment",
] as const;

export { spaceCollection } from "./space/index.ts";
export {
  spaceAttachmentCollection,
  spaceAttachmentId,
} from "./space-attachment/index.ts";
