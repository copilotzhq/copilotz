import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { fetchTextTool } from "./index.ts";

Deno.test("fetchTextTool maps to the Fetch Text Action alias", () => {
  assertEquals(
    fetchTextTool[contribution]({ namespace: "tools", alias: "fetch_text" })
      .value.action,
    "fetch_text",
  );
});
