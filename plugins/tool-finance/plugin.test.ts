/** Tests composition of the concrete Finance Tool plugin. @module */

import { assertEquals } from "@std/assert";
import { financeToolsPlugin } from "./plugin.ts";
import type { ToolResource } from "@copilotz/copilotz/tools";

Deno.test("Finance plugin composes an Action with a data-only Tool Resource", () => {
  const plugin = financeToolsPlugin;
  const tools = plugin.resources.tools;
  assertEquals(Object.keys(tools ?? {}), ["finance"]);
  const tool = tools?.finance as ToolResource;

  assertEquals(tool?.action, "finance");
  assertEquals("execute" in (tool ?? {}), false);
});
