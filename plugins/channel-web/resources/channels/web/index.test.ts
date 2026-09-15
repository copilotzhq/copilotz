import { assertEquals } from "@std/assert";
import { webChannelResource } from "./index.ts";
Deno.test("Web channel policy can be overridden without changing the default", () => {
  const resource = {
    ...webChannelResource,
    defaultAgentAliases: ["assistant"],
  };
  assertEquals(resource.egress, "request-observation");
  assertEquals(webChannelResource.defaultAgentAliases, undefined);
});
