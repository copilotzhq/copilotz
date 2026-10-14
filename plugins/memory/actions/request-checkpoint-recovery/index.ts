import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { MemoryActionContext } from "../../shared/contracts.ts";

export const REQUEST_MEMORY_CHECKPOINT_RECOVERY_ACTION_ID =
  "copilotz.memory.request-checkpoint-recovery";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["checkpointId"],
  properties: { checkpointId: { type: "string", minLength: 1 } },
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["checkpointId"],
  properties: { checkpointId: { type: "string", minLength: 1 } },
} as const;

type Input = Readonly<{ checkpointId: string }>;
type Output = Readonly<{ checkpointId: string }>;

/** The completed Action receipt durably hands repair to a detached processor. */
export const requestMemoryCheckpointRecoveryAction: ActionDefinition<
  Input,
  Output,
  MemoryActionContext,
  typeof inputSchema,
  typeof outputSchema
> = defineAction({
  id: REQUEST_MEMORY_CHECKPOINT_RECOVERY_ACTION_ID,
  inputSchema,
  outputSchema,
  execute(input, _context) {
    // The consumer re-reads the checkpoint under its detached delivery. This
    // Action intentionally carries only an identity and has no side effects.
    return { checkpointId: input.checkpointId };
  },
});

export default requestMemoryCheckpointRecoveryAction;
