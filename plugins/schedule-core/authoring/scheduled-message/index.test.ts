import { assertEquals } from "@std/assert";
import { normalizeCoreScheduledMessagePayload } from "./index.ts";

Deno.test("normalizeCoreScheduledMessagePayload preserves typed recipients", () => {
  assertEquals(
    normalizeCoreScheduledMessagePayload({
      type: "copilotz.core.scheduled-message",
      recipientIds: ["assistant"],
    }).recipientIds,
    ["assistant"],
  );
});
