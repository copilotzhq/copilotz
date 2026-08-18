import { assert, assertEquals, assertThrows } from "@std/assert";

import type { WorkflowTool } from "./types.ts";
import { createWebToolsPlugin, WEB_TOOL_IDS } from "./web-plugin.ts";

Deno.test("Web tools compose as stable plugin resources", () => {
  const plugin = createWebToolsPlugin();
  assertEquals(plugin.manifest.provides.tools, [...WEB_TOOL_IDS]);
  assertEquals(
    plugin.resources.tools?.map((value) => (value as WorkflowTool).key),
    [...WEB_TOOL_IDS],
  );
  assert(
    plugin.resources.tools?.every((value) =>
      typeof (value as WorkflowTool).execute === "function" &&
      Object.isFrozen(value)
    ),
  );
});

Deno.test("Web tool selection is explicit and validated", () => {
  assertEquals(
    createWebToolsPlugin({ include: ["fetch_text"] }).manifest.provides.tools,
    ["fetch_text"],
  );
  assertThrows(
    () => createWebToolsPlugin({ include: ["fetch_text", "fetch_text"] }),
    TypeError,
    "duplicate IDs",
  );
  assertThrows(
    () => createWebToolsPlugin({ include: ["missing" as "fetch_text"] }),
    TypeError,
    "Unknown Web tool",
  );
});

Deno.test("Web tool plugin excludes filesystem, process, and class APIs", async () => {
  for (
    const module of [
      "web-plugin.ts",
      "web/http-request.ts",
      "web/fetch-text.ts",
      "web/web-search.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\./.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bprocess\./.test(source), module);
    assert(!/^\s*(?:export\s+)?class\s/m.test(source), module);
  }
});
