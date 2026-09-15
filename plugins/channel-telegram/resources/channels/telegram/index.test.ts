import { assertEquals } from "@std/assert";
import { telegramChannelResource } from "./index.ts";

Deno.test("Telegram Channel Resource is data-only external policy", () => {
  const resource = {
    ...telegramChannelResource,
    ...{
      defaultAgentAliases: ["assistant"],
    },
  };
  assertEquals(resource.egress, "external");
  assertEquals(resource.defaultAgentAliases, ["assistant"]);
});
