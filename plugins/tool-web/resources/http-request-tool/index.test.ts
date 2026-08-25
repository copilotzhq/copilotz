import { assertEquals } from "@std/assert";
import { httpRequestTool } from "./index.ts";

Deno.test("httpRequestTool maps to the HTTP Action alias", () => {
  assertEquals(httpRequestTool.action, "http_request");
});
