import { assertEquals } from "@std/assert";
import { createDiscordChannelResource } from "./index.ts";

Deno.test("Discord Channel Resource is data-only external policy", () => {
  const resource = createDiscordChannelResource({
    defaultAgentAliases: ["assistant"],
  });
  assertEquals(resource.egress, "external");
  assertEquals(resource.defaultAgentAliases, ["assistant"]);
});
