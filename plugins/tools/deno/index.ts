import applyPatch from "./apply-patch.ts";
import listDirectory from "./list-directory.ts";
import readFile from "./read-file.ts";
import restoreFileVersion from "./restore-file-version.ts";
import runCommand from "./run-command.ts";
import searchCode from "./search-code.ts";
import searchFiles from "./search-files.ts";
import showFileDiff from "./show-file-diff.ts";
import writeFile from "./write-file.ts";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { NewTool } from "@copilotz/copilotz/resources";
import type { WorkflowTool } from "@copilotz/copilotz/tools";

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

export type CreateWorkspaceToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly WorkspaceToolId[];
}>;

export type CreateProcessToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly ProcessToolId[];
}>;

const workspaceDefinitions: Readonly<
  Record<WorkspaceToolId, NewTool>
> = Object.freeze({
  read_file: readFile,
  write_file: writeFile,
  list_directory: listDirectory,
  search_files: searchFiles,
  search_code: searchCode,
  apply_patch: applyPatch,
  show_file_diff: showFileDiff,
  restore_file_version: restoreFileVersion,
});

const processDefinitions: Readonly<Record<ProcessToolId, NewTool>> = Object
  .freeze({ run_command: runCommand });

function selectedTools<Id extends string>(
  kind: string,
  ids: readonly Id[],
  available: readonly Id[],
  definitions: Readonly<Record<Id, NewTool>>,
): readonly WorkflowTool[] {
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${kind} tool selection contains duplicate IDs.`);
  }
  return Object.freeze(ids.map((id) => {
    if (!available.includes(id)) {
      throw new TypeError(`Unknown ${kind} tool '${id}'.`);
    }
    const value = definitions[id];
    if (typeof value.execute !== "function") {
      throw new TypeError(`${kind} tool '${id}' has no executor.`);
    }
    return Object.freeze({
      ...value,
      id: value.id || value.key,
      execute: value.execute,
    }) as WorkflowTool;
  }));
}

/** Filesystem adapter preserving the bounded workspace tool contracts. */
export function createWorkspaceToolsPlugin(
  options: CreateWorkspaceToolsPluginOptions = {},
): CopilotzPlugin {
  const tools = selectedTools(
    "workspace",
    options.include ?? WORKSPACE_TOOL_IDS,
    WORKSPACE_TOOL_IDS,
    workspaceDefinitions,
  );
  return definePlugin({
    id: options.id ?? "@copilotz/workspace-tools",
    version: options.version ?? "3.0.0",
    resources: {
      tools: Object.fromEntries(tools.map((tool) => [tool.key, tool])),
    },
  });
}

/** Subprocess adapter; persistent terminal execution remains separate. */
export function createProcessToolsPlugin(
  options: CreateProcessToolsPluginOptions = {},
): CopilotzPlugin {
  const tools = selectedTools(
    "process",
    options.include ?? PROCESS_TOOL_IDS,
    PROCESS_TOOL_IDS,
    processDefinitions,
  );
  return definePlugin({
    id: options.id ?? "@copilotz/process-tools",
    version: options.version ?? "3.0.0",
    resources: {
      tools: Object.fromEntries(tools.map((tool) => [tool.key, tool])),
    },
  });
}
