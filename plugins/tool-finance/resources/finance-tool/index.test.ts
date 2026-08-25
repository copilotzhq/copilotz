/** Tests the Finance Tool Resource's data-only presentation. @module */

import { assertEquals } from "@std/assert";
import { createFinanceAction } from "../../actions/index.ts";
import { financeToolResource } from "./index.ts";

Deno.test("Finance Tool Resource copies Action schemas without executable code", () => {
  const tool = financeToolResource(
    createFinanceAction({ getProvider: () => ({}) as never }),
  );
  assertEquals(tool.action, "finance");
  assertEquals(Object.isFrozen(tool), true);
  assertEquals("execute" in tool, false);
  assertEquals(tool.inputSchema?.type, "object");
});
