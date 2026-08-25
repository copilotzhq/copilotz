import { assertThrows } from "@std/assert";
import { createTelegramChannelAdapter } from "./index.ts";

Deno.test("Telegram Channel Adapter requires provider config", () => {
  assertThrows(
    () => createTelegramChannelAdapter(undefined as never),
    TypeError,
    "requires config",
  );
});
