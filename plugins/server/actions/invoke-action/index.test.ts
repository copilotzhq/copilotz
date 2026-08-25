import { assertEquals } from "@std/assert";
import { serverInvokeAction } from "./index.ts";

Deno.test("Server invoke Action owns its stable internal identity", () => {
  assertEquals(serverInvokeAction.id, "copilotz.server.internal.invoke");
  assertEquals(Object.isFrozen(serverInvokeAction), true);
});
