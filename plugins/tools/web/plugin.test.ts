import { assert, assertEquals, assertThrows } from "@std/assert";

import type { WorkflowTool } from "../internal/types.ts";
import { createWebToolsPlugin, WEB_TOOL_IDS } from "./plugin.ts";

Deno.test("Web tools compose as stable plugin resources", () => {
  const plugin = createWebToolsPlugin();
  const tools = plugin.resources.tools as
    | Readonly<Record<string, WorkflowTool>>
    | undefined;
  assertEquals(Object.keys(tools ?? {}), [...WEB_TOOL_IDS]);
  assertEquals(
    Object.values(tools ?? {}).map((value) => value.key),
    [...WEB_TOOL_IDS],
  );
  assert(
    Object.values(tools ?? {}).every((value) =>
      typeof value.execute === "function" &&
      Object.isFrozen(value)
    ),
  );
});

Deno.test("Web tool selection is explicit and validated", () => {
  assertEquals(
    Object.keys(
      createWebToolsPlugin({ include: ["fetch_text"] }).resources.tools ?? {},
    ),
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
      "plugin.ts",
      "http-request.ts",
      "fetch-text.ts",
      "web-search.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\./.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bprocess\./.test(source), module);
    assert(!/^\s*(?:export\s+)?class\s/m.test(source), module);
  }
});
