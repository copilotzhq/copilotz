/** Execution context and result contracts shared by Memory primitives. @module */
import type {
  ActionCallOptions,
  ActionContext,
} from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type {
  MemoryAdapters,
  MemoryResources,
} from "../authoring/contracts/index.ts";

export type ConsolidateMemoryActionInput = unknown;

export type ConsolidateMemoryActionResult = Readonly<
  & {
    outcome: "already_settled" | "no_changes" | "changes" | "invalidated";
  }
  & Record<string, unknown>
>;

export type MemoryActionCallers = Readonly<{
  consolidate_memory(
    input: ConsolidateMemoryActionInput,
    options?: ActionCallOptions,
  ): Promise<ConsolidateMemoryActionResult>;
  list_knowledge_spaces(
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
  search_memory(input: unknown, options?: ActionCallOptions): Promise<unknown>;
  inspect_memory(input: unknown, options?: ActionCallOptions): Promise<unknown>;
  request_memory_checkpoint_recovery(
    input: Readonly<{ checkpointId: string }>,
    options?: ActionCallOptions,
  ): Promise<Readonly<{ checkpointId: string }>>;
}>;

export type MemoryActionContext = ActionContext<
  MemoryResources,
  MemoryAdapters,
  MemoryActionCallers
>;

export type MemoryProcessorContext = ProcessorContext<
  MemoryResources,
  MemoryAdapters,
  MemoryActionCallers
>;
