/** Public names for generated plugin composition. @module */
export { default as builtInToolsPlugin } from "./plugin.generated.ts";
export const BUILT_IN_CORE_TOOL_IDS = [
  "create_thread",
  "end_thread",
  "fetch_asset",
  "get_current_time",
  "save_asset",
  "update_my_memory",
  "update_user_memory",
  "wait",
] as const;
export type BuiltInCoreToolId = typeof BUILT_IN_CORE_TOOL_IDS[number];
