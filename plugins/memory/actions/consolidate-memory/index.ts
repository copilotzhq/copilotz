/**
 * Commits one validated semantic-memory consolidation proposal.
 *
 * @module
 */

import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type ConsolidateMemoryActionInput,
  type ConsolidateMemoryActionResult,
  createConsolidateMemoryAction as createImplementation,
  type MemoryActionContext,
} from "../../internal/implementation.ts";
import type { LongTermMemoryConfig } from "../../resources/config/index.ts";

export const CONSOLIDATE_MEMORY_ACTION_ID =
  "copilotz.memory.consolidation.commit";

export function createConsolidateMemoryAction(
  config: LongTermMemoryConfig,
): ActionDefinition<
  ConsolidateMemoryActionInput,
  ConsolidateMemoryActionResult,
  MemoryActionContext,
  ActionSchema
> {
  const implementation = createImplementation(config);
  return defineAction<
    ConsolidateMemoryActionInput,
    ConsolidateMemoryActionResult,
    MemoryActionContext,
    ActionSchema
  >({
    id: CONSOLIDATE_MEMORY_ACTION_ID,
    inputSchema: implementation.inputSchema,
    execute: implementation.execute,
  });
}

export type { ConsolidateMemoryActionInput, ConsolidateMemoryActionResult };
