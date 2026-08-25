import { assertEquals } from "@std/assert";
import { httpRequestAction } from "./index.ts";

Deno.test("httpRequestAction owns its durable identity", () => {
  assertEquals(httpRequestAction.id, "copilotz.tools.web.http_request");
});
