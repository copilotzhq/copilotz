import applyPatch from "./tools/apply-patch.ts";
import listDirectory from "./tools/list-directory.ts";
import readFile from "./tools/read-file.ts";
import restoreFileVersion from "./tools/restore-file-version.ts";
import runCommand from "./tools/run-command.ts";
import searchCode from "./tools/search-code.ts";
import searchFiles from "./tools/search-files.ts";
import showFileDiff from "./tools/show-file-diff.ts";
import writeFile from "./tools/write-file.ts";
import type { NewTool } from "../../resources/index.ts";
import { type CopilotzPlugin, definePlugin } from "../../plugins/index.ts";
import type { WorkflowTool } from "../../workflows/index.ts";

export const DENO_WORKSPACE_TOOL_IDS = [
  "read_file",
  "write_file",
  "list_directory",
  "search_files",
  "search_code",
  "apply_patch",
  "show_file_diff",
  "restore_file_version",
] as const;

export const DENO_PROCESS_TOOL_IDS = ["run_command"] as const;

export type DenoWorkspaceToolId = typeof DENO_WORKSPACE_TOOL_IDS[number];
export type DenoProcessToolId = typeof DENO_PROCESS_TOOL_IDS[number];

export type CreateDenoWorkspaceToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly DenoWorkspaceToolId[];
}>;

export type CreateDenoProcessToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly DenoProcessToolId[];
}>;

const workspaceDefinitions: Readonly<
  Record<DenoWorkspaceToolId, NewTool>
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

const processDefinitions: Readonly<Record<DenoProcessToolId, NewTool>> = Object
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

/** Deno filesystem adapter preserving the bounded workspace tool contracts. */
export function createDenoWorkspaceToolsPlugin(
  options: CreateDenoWorkspaceToolsPluginOptions = {},
): CopilotzPlugin {
  const tools = selectedTools(
    "Deno workspace",
    options.include ?? DENO_WORKSPACE_TOOL_IDS,
    DENO_WORKSPACE_TOOL_IDS,
    workspaceDefinitions,
  );
  return definePlugin({
    manifest: {
      id: options.id ?? "@copilotz/deno-workspace-tools",
      version: options.version ?? "3.0.0",
      provides: { tools: tools.map((tool) => tool.key) },
    },
    resources: { tools },
  });
}

/** Deno subprocess adapter; persistent terminal migration remains separate. */
export function createDenoProcessToolsPlugin(
  options: CreateDenoProcessToolsPluginOptions = {},
): CopilotzPlugin {
  const tools = selectedTools(
    "Deno process",
    options.include ?? DENO_PROCESS_TOOL_IDS,
    DENO_PROCESS_TOOL_IDS,
    processDefinitions,
  );
  return definePlugin({
    manifest: {
      id: options.id ?? "@copilotz/deno-process-tools",
      version: options.version ?? "3.0.0",
      provides: { tools: tools.map((tool) => tool.key) },
    },
    resources: { tools },
  });
}
