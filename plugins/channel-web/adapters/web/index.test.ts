import { assertEquals } from "@std/assert";
import { createWebChannelAdapter } from "./index.ts";

Deno.test("Web Channel Adapter accepts one occurrence", async () => {
  const accepted = await createWebChannelAdapter().accept({
    method: "POST",
    headers: {},
    body: { id: "web-1", input: { hello: "world" } },
  }, {} as never);
  assertEquals(accepted.status, 202);
  assertEquals(accepted.occurrences, [{
    id: "web-1",
    input: { hello: "world" },
  }]);
});
