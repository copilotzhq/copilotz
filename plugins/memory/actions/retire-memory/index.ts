/** Permanent retirement through the same current scope authorization as search. @module */
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { MemoryActionContext } from "../../shared/contracts.ts";
import {
  memoryActionProvenance,
  threadMemorySpaces,
} from "../../shared/access.ts";
import { record, requiredText } from "../../shared/input.ts";

export const retireMemoryAction: ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext
> = defineAction({
  id: "copilotz.memory.retire",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "reason"],
    properties: {
      id: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 },
    },
  },
  async execute(raw, context) {
    const input = record(raw);
    const provenance = memoryActionProvenance(context);
    const spaces = await threadMemorySpaces(
      context,
      provenance.threadId,
      provenance.initiatorParticipantId,
    );
    const id = requiredText(input.id, "id");
    const note = await context.collections.memoryNote.get({ id });
    if (!note || !spaces.some((space) => space.id === note.memorySpaceId)) {
      throw new Error("Memory item is unavailable.");
    }
    await context.collections.memoryNote.commands.retire({
      id,
      memorySpaceId: note.memorySpaceId,
      retirement: {
        checkpointId: `retire:${context.action.runId}`,
        retiredAt: context.now().toISOString(),
        retiredBy: provenance.agentId,
        reason: requiredText(input.reason, "reason"),
      },
    }, { operationKey: "memory:retire" });
    return { id, state: "retired" };
  },
});
export default retireMemoryAction;
