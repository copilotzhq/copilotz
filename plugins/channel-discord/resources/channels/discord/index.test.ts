import { assertEquals } from "@std/assert";
import { discordChannelResource } from "./index.ts";

Deno.test("Discord Channel Resource is data-only external policy", () => {
  const resource = {
    ...discordChannelResource,
    ...{
      defaultAgentAliases: ["assistant"],
    },
  };
  assertEquals(resource.egress, "external");
  assertEquals(resource.defaultAgentAliases, ["assistant"]);
});
