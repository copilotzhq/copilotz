import { assertEquals } from "@std/assert";
import { serverActionRequestProcessor } from "./index.ts";

Deno.test("Server Action request Processor owns its Event match", () => {
  assertEquals(
    serverActionRequestProcessor.id,
    "copilotz.server.action-request",
  );
  assertEquals(serverActionRequestProcessor.on, [{
    eventType: "copilotz.server.action.requested",
  }]);
});
