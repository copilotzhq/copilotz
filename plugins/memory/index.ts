/** Memory plugin: immutable notes and conversation continuity. @module */
export {
  DEFAULT_LONG_TERM_MEMORY_CONFIG,
  type LongTermMemoryConfig,
} from "./resources/memory/config/index.ts";
export {
  longTermMemoryCollection,
  memoryNoteCollection,
  memorySpaceAccessCollection,
  memorySpaceCollection,
} from "./collections/index.ts";
export { CONSOLIDATE_MEMORY_ACTION_ID, memoryPlugin } from "./plugin.ts";
export type { LongTermMemoryPlugin } from "./plugin.ts";
export type {
  ConsolidateMemoryActionInput,
  ConsolidateMemoryActionResult,
} from "./actions/consolidate-memory/index.ts";
export type {
  MemoryActionCallers,
  MemoryActionContext,
  MemoryProcessorContext,
} from "./shared/contracts.ts";
export * from "./authoring/index.ts";
