import {
  type ActionContinuation,
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { MemoryActionContext } from "../../shared/contracts.ts";
import { memoryCheckpointOperation } from "../../shared/checkpoints.ts";
export const coordinateCheckpointAction: ActionDefinition<
  { checkpointId: string },
  unknown | ActionContinuation,
  MemoryActionContext
> = defineAction({
  id: "copilotz.memory.coordinate-checkpoint",
  execute(input: { checkpointId: string }, context: MemoryActionContext) {
    return context.awaitOperation({
      start: memoryCheckpointOperation(context, input.checkpointId),
      handoff: input,
    });
  },
  resume(handoff: unknown) {
    return handoff;
  },
});

export default coordinateCheckpointAction;
