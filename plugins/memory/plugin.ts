/** Public names for generated plugin composition. @module */
import memoryPlugin from "./plugin.generated.ts";
export { memoryPlugin };
export type LongTermMemoryPlugin = typeof memoryPlugin;
export { CONSOLIDATE_MEMORY_ACTION_ID } from "./actions/consolidate-memory/index.ts";
