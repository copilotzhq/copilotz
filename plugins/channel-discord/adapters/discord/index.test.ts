import { assertThrows } from "@std/assert";
import { createDiscordChannelAdapter } from "./index.ts";

Deno.test("Discord Channel Adapter requires provider config", () => {
  assertThrows(
    () => createDiscordChannelAdapter(undefined as never),
    TypeError,
    "requires config",
  );
});
