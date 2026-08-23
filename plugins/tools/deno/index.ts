import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { ToolResource } from "../contracts.ts";
import { applyPatchAction, applyPatchTool } from "./apply-patch.ts";
import { listDirectoryAction, listDirectoryTool } from "./list-directory.ts";
import { readFileAction, readFileTool } from "./read-file.ts";
import {
  restoreFileVersionAction,
  restoreFileVersionTool,
} from "./restore-file-version.ts";
import { runCommandAction, runCommandTool } from "./run-command.ts";
import { searchCodeAction, searchCodeTool } from "./search-code.ts";
import { searchFilesAction, searchFilesTool } from "./search-files.ts";
import { showFileDiffAction, showFileDiffTool } from "./show-file-diff.ts";
import { writeFileAction, writeFileTool } from "./write-file.ts";

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

type NativeToolDefinition = Readonly<{
  action: AnyActionDefinition;
  tool: ToolResource;
}>;

const workspaceDefinitions: Readonly<
  Record<WorkspaceToolId, NativeToolDefinition>
> = Object.freeze({
  read_file: { action: readFileAction, tool: readFileTool },
  write_file: { action: writeFileAction, tool: writeFileTool },
  list_directory: { action: listDirectoryAction, tool: listDirectoryTool },
  search_files: { action: searchFilesAction, tool: searchFilesTool },
  search_code: { action: searchCodeAction, tool: searchCodeTool },
  apply_patch: { action: applyPatchAction, tool: applyPatchTool },
  show_file_diff: { action: showFileDiffAction, tool: showFileDiffTool },
  restore_file_version: {
    action: restoreFileVersionAction,
    tool: restoreFileVersionTool,
  },
});

const processDefinitions: Readonly<
  Record<ProcessToolId, NativeToolDefinition>
> = Object.freeze({
  run_command: { action: runCommandAction, tool: runCommandTool },
});

function selectedDefinitions<Id extends string>(
  kind: string,
  ids: readonly Id[],
  available: readonly Id[],
  definitions: Readonly<Record<Id, NativeToolDefinition>>,
): readonly (readonly [Id, NativeToolDefinition])[] {
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${kind} tool selection contains duplicate IDs.`);
  }
  return Object.freeze(ids.map((id) => {
    if (!available.includes(id)) {
      throw new TypeError(`Unknown ${kind} tool '${id}'.`);
    }
    return [id, definitions[id]] as const;
  }));
}

function nativePlugin(
  id: string,
  version: string,
  selected: readonly (readonly [string, NativeToolDefinition])[],
): CopilotzPlugin {
  return definePlugin({
    id,
    version,
    actions: Object.fromEntries(
      selected.map(([alias, value]) => [alias, value.action]),
    ),
    resources: {
      tools: Object.fromEntries(
        selected.map(([alias, value]) => [alias, value.tool]),
      ),
    },
  });
}

/** Filesystem adapter preserving the bounded workspace tool contracts. */
export function createWorkspaceToolsPlugin(
  options: CreateWorkspaceToolsPluginOptions = {},
): CopilotzPlugin {
  const selected = selectedDefinitions(
    "workspace",
    options.include ?? WORKSPACE_TOOL_IDS,
    WORKSPACE_TOOL_IDS,
    workspaceDefinitions,
  );
  return nativePlugin(
    options.id ?? "@copilotz/workspace-tools",
    options.version ?? "3.0.0",
    selected,
  );
}

/** Subprocess adapter; persistent terminal execution remains separate. */
export function createProcessToolsPlugin(
  options: CreateProcessToolsPluginOptions = {},
): CopilotzPlugin {
  const selected = selectedDefinitions(
    "process",
    options.include ?? PROCESS_TOOL_IDS,
    PROCESS_TOOL_IDS,
    processDefinitions,
  );
  return nativePlugin(
    options.id ?? "@copilotz/process-tools",
    options.version ?? "3.0.0",
    selected,
  );
}
