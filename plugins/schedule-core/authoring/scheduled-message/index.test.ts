import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("normalizeCoreScheduledMessagePayload requires explicit recipients", () => {
  assertThrows(
    () =>
      normalizeCoreScheduledMessagePayload({
        type: "copilotz.core.scheduled-message",
      }),
    TypeError,
    "Scheduled recipient ID must be an array",
  );
  assertThrows(
    () =>
      normalizeCoreScheduledMessagePayload({
        type: "copilotz.core.scheduled-message",
        recipientIds: [],
      }),
    TypeError,
    "must contain at least one value",
  );
});
