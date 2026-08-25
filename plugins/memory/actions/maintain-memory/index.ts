/**
 * Runs the model-mediated maintenance workflow for a reserved checkpoint.
 *
 * @module
 */

import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  createMemoryMaintenanceAction as createImplementation,
  type MaintainMemoryActionInput,
  type MaintainMemoryActionResult,
  type MemoryActionContext,
} from "../../internal/implementation.ts";
import type { ToolResource } from "@copilotz/copilotz/tools";

export const MAINTAIN_MEMORY_ACTION_ID = "copilotz.memory.maintenance.run";

export function createMemoryMaintenanceAction(
  models: readonly [string, ...string[]] | undefined,
  tool: ToolResource<"consolidate_memory">,
  maxRepairAttempts: number,
): ActionDefinition<
  MaintainMemoryActionInput,
  MaintainMemoryActionResult,
  MemoryActionContext,
  ActionSchema
> {
  const implementation = createImplementation(models, tool, maxRepairAttempts);
  return defineAction<
    MaintainMemoryActionInput,
    MaintainMemoryActionResult,
    MemoryActionContext,
    ActionSchema
  >({
    id: MAINTAIN_MEMORY_ACTION_ID,
    inputSchema: implementation.inputSchema,
    execute: implementation.execute,
  });
}

export type { MaintainMemoryActionInput, MaintainMemoryActionResult };
