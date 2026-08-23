import { assert, assertEquals } from "@std/assert";
import {
  createProcessToolsPlugin,
  createWorkspaceToolsPlugin,
  PROCESS_TOOL_IDS,
  WORKSPACE_TOOL_IDS,
} from "./index.ts";
import * as denoTools from "./index.ts";

Deno.test("Deno Tool plugins expose workspace and process actions by stable ID", () => {
  const workspace = createWorkspaceToolsPlugin();
  const process = createProcessToolsPlugin();
  const workspaceTools = workspace.resources.tools ?? {};
  const processTools = process.resources.tools ?? {};
  assertEquals(Object.keys(workspaceTools), [...WORKSPACE_TOOL_IDS]);
  assertEquals(Object.keys(processTools), [...PROCESS_TOOL_IDS]);
  assertEquals(workspace.id, "@copilotz/workspace-tools");
  assertEquals(process.id, "@copilotz/process-tools");
  assert(Object.values(workspaceTools).every((tool) => Object.isFrozen(tool)));
  assertEquals(
    Object.keys(
      createWorkspaceToolsPlugin({ include: ["read_file"] }).resources
        .tools ?? {},
    ),
    ["read_file"],
  );
  for (
    const removed of [
      "createDenoProcessToolsPlugin",
      "createDenoWorkspaceToolsPlugin",
      "DENO_PROCESS_TOOL_IDS",
      "DENO_WORKSPACE_TOOL_IDS",
    ]
  ) assertEquals(removed in denoTools, false, removed);
});
