import { assertEquals } from "@std/assert";
import { createTelegramChannelResource } from "./index.ts";

Deno.test("Telegram Channel Resource is data-only external policy", () => {
  const resource = createTelegramChannelResource({
    defaultAgentAliases: ["assistant"],
  });
  assertEquals(resource.egress, "external");
  assertEquals(resource.defaultAgentAliases, ["assistant"]);
});
