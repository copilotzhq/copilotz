import { contribution } from "@copilotz/copilotz/plugins";
import { assertEquals } from "@std/assert";
import { httpRequestTool } from "./index.ts";

Deno.test("httpRequestTool maps to the HTTP Action alias", () => {
  assertEquals(
    httpRequestTool[contribution]({ namespace: "tools", alias: "http_request" })
      .value.action,
    "http_request",
  );
});
