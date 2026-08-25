import { assertEquals, assertExists } from "@std/assert";
import { createServerPlugin, serverPlugin } from "./plugin.ts";

Deno.test("Server plugin composes one Resource and durable bridge", () => {
  assertEquals(serverPlugin.id, "copilotz.server");
  assertExists(serverPlugin.actions.serverInvoke);
  assertExists(serverPlugin.processors.serverActionRequest);
  assertEquals(
    (serverPlugin.resources.server.default as { basePath: string }).basePath,
    "/api/v1",
  );
  assertEquals(
    (createServerPlugin({ basePath: "/custom" }).resources.server.default as {
      basePath: string;
    }).basePath,
    "/custom",
  );
});
