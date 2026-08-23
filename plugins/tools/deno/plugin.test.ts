import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
import { runCommandAction } from "./run-command.ts";
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
  assertEquals(Object.keys(workspace.actions), [...WORKSPACE_TOOL_IDS]);
  assertEquals(Object.keys(process.actions), [...PROCESS_TOOL_IDS]);
  for (const [alias, tool] of Object.entries(workspaceTools)) {
    assertEquals((tool as { action: string }).action, alias);
    assert(!("execute" in (tool as object)));
  }
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

Deno.test("run_command surfaces Action cancellation and terminates its child", async () => {
  const controller = new AbortController();
  const execution = runCommandAction.execute({
    command: Deno.execPath(),
    args: ["eval", "await new Promise(() => {})"],
  }, {
    signal: controller.signal,
  } as ActionContext);
  setTimeout(() => controller.abort(), 25);
  const error = await assertRejects(async () => await execution);
  assertEquals((error as Error).name, "AbortError");
});
