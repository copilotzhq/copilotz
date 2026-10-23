/** Profile maintenance for a policy-bound authenticated human. @module */
import {
  type ActionContext,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { importPersonalMemory } from "../../shared/personal.ts";
import { memorySpaceId } from "../../shared/access.ts";
import { record, requiredText } from "../../shared/input.ts";

export const personalMemoryAction: ActionDefinition<
  unknown,
  unknown,
  ActionContext
> = defineAction({
  id: "copilotz.memory.personal",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: { enum: ["import", "retire"] },
      id: { type: "string", minLength: 1 },
    },
  },
  async execute(raw, context) {
    // HTTP policies must bind this to the authenticated participant, never input.
    const participantId = requiredText(
      context.action.metadata.initiatorParticipantId,
      "Authenticated participant",
    );
    const human = await context.collections.participant.get({
      id: participantId,
    });
    if (human?.participantType !== "human") {
      throw new Error("Personal memory requires a human.");
    }
    await importPersonalMemory(context.collections, human);
    const input = record(raw);
    if (input.operation === "retire") {
      await context.collections.memoryNote.commands.retire({
        id: requiredText(input.id, "Memory item"),
        memorySpaceId: memorySpaceId("personal", participantId),
        retirement: {
          checkpointId: `profile:${context.action.runId}`,
          retiredAt: context.now().toISOString(),
          retiredBy: participantId,
          reason: "Removed by its owner.",
        },
      }, { operationKey: "profile:retire-memory" });
    }
    return { success: true };
  },
});
export default personalMemoryAction;
