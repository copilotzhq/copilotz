import { assertThrows } from "@std/assert";
import { createZendeskChannelAdapter } from "./index.ts";

Deno.test("Zendesk Channel Adapter requires provider config", () => {
  assertThrows(
    () => createZendeskChannelAdapter(undefined as never),
    TypeError,
    "requires config",
  );
});
