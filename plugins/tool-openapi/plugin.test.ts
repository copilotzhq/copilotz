/**
 * Verifies OpenAPI generator composition stays at the plugin boundary.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { defineTool } from "../tools/authoring/define-tool/index.ts";
import { composeOpenApiToolsPlugin } from "./plugin.ts";

Deno.test("OpenAPI composition preserves generated action and tool aliases", () => {
  const action = defineAction({
    id: "test.openapi.operation",
    inputSchema: { type: "object", properties: {} },
    execute: () => ({ ok: true }),
  });
  const plugin = composeOpenApiToolsPlugin({
    id: "@test/openapi",
    version: "1.0.0",
    entries: [{
      alias: "operation",
      action,
      tool: defineTool("operation", action, {
        name: "Operation",
        description: "Test OpenAPI operation.",
      }),
    }],
  });

  assertEquals(Object.keys(plugin.actions), ["operation"]);
  assertEquals(Object.keys(plugin.resources.tools ?? {}), ["operation"]);
});
