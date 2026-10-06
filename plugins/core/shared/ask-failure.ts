/** Settles owned Ask failures through their existing deferred Tool-plan cursor. */
import type { CoreToolProcessorContext } from "./runtime-context.ts";
import type { AgentAskMetadata } from "./workflow-metadata.ts";
import { resumeDeferredToolPlan } from "./tool-plan.ts";
import { asRecord, optionalText } from "./helpers.ts";

export async function settleAskFailure(
  context: CoreToolProcessorContext,
  ask: AgentAskMetadata,
  agentParticipantId: string,
  error: unknown,
  cancelled: boolean,
  ownerEventId: string,
): Promise<void> {
  if (agentParticipantId !== ask.askedParticipantId) {
    throw new Error(`Ask '${ask.askId}' failure ownership does not match.`);
  }
  const cause = optionalText(asRecord(error).message) ??
    (cancelled ? "The asked agent was cancelled." : "The asked agent failed.");
  await resumeDeferredToolPlan(context, ask, {
    status: cancelled ? "cancelled" : "failed",
    error: {
      name: cancelled ? "AgentAskCancelled" : "AgentAskFailed",
      message: cancelled
        ? `Ask to agent '${ask.askedAgentId}' was cancelled: ${cause}`
        : `Asked agent '${ask.askedAgentId}' failed: ${cause}`,
    },
  }, { ownerEventId });
}
