import { contribution } from "@copilotz/copilotz/plugins";
/** Tests the Finance Tool Resource's data-only presentation. @module */

import { assertEquals } from "@std/assert";
import { financeToolResource } from "./index.ts";

Deno.test("Finance Tool Resource copies Action schemas without executable code", () => {
  const tool = financeToolResource;
  assertEquals(
    tool[contribution]({ namespace: "tools", alias: "finance" }).value.action,
    "finance",
  );

  assertEquals("execute" in tool, false);
  assertEquals(
    tool[contribution]({ namespace: "tools", alias: "finance" }).value
      .inputSchema?.type,
    "object",
  );
});
