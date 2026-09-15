import { defineServerFacade as fixtureServerFacade } from "@copilotz/copilotz/server";
import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assertEquals, assertExists } from "@std/assert";
import { serverPlugin } from "./plugin.ts";

Deno.test("Server plugin composes one Resource and durable bridge", () => {
  assertEquals(serverPlugin.id, "copilotz.server");
  assertExists(serverPlugin.actions.serverInvoke);
  assertExists(serverPlugin.processors.serverActionRequest);
  assertEquals(
    (serverPlugin.resources.server.default as { basePath: string }).basePath,
    "/api",
  );
  assertEquals(
    (defineFixturePlugin({
      ...serverPlugin,
      resources: {
        server: { default: fixtureServerFacade({ basePath: "/custom" }) },
      },
    }).resources.server.default as {
      basePath: string;
    }).basePath,
    "/custom",
  );
});
