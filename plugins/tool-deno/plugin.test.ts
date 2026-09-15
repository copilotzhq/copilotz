import { definePlugin } from "@copilotz/copilotz/plugins";
import { readFileTool, runCommandTool } from "./resources/index.ts";
import { assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
/**
 * Verifies selectable Deno Tool plugin composition and cancellation.
 *
 * @module
 */

import { runCommandAction } from "./actions/run-command/index.ts";

Deno.test("Deno tool selection keeps process execution explicit", () => {
  const workspace = definePlugin({
    id: "test.workspace",
    version: "1",
    resources: { tools: { read_file: readFileTool } },
  });
  const process = definePlugin({
    id: "test.process",
    version: "1",
    resources: { tools: { run_command: runCommandTool } },
  });
  assertEquals(Object.keys(workspace.actions), ["read_file"]);
  assertEquals(Object.keys(process.actions), ["run_command"]);
  assertEquals("run_command" in workspace.actions, false);
});

Deno.test("run_command surfaces Action cancellation and terminates its child", async () => {
  const controller = new AbortController();
  const execution = runCommandAction.execute({
    command: Deno.execPath(),
    // A pending Promise alone lets Deno exit before cancellation is exercised.
    args: ["eval", "setInterval(() => {}, 1000)"],
  }, {
    signal: controller.signal,
  } as ActionContext);
  setTimeout(() => controller.abort(), 25);
  const error = await assertRejects(async () => await execution);
  assertEquals((error as Error).name, "AbortError");
});
