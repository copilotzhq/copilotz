/** Public names for generated plugin composition. @module */
export { default as denoToolsPlugin } from "./plugin.generated.ts";
export const WORKSPACE_TOOL_IDS = [
  "read_file",
  "write_file",
  "list_directory",
  "search_files",
  "search_code",
  "apply_patch",
  "show_file_diff",
  "restore_file_version",
] as const;

export const PROCESS_TOOL_IDS = ["run_command"] as const;

export type WorkspaceToolId = typeof WORKSPACE_TOOL_IDS[number];
export type ProcessToolId = typeof PROCESS_TOOL_IDS[number];
