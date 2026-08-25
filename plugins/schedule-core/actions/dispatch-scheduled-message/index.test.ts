import { assertEquals } from "@std/assert";
import { dispatchScheduledMessageAction } from "./index.ts";

Deno.test("dispatchScheduledMessageAction owns the Core dispatch identity", () => {
  assertEquals(
    dispatchScheduledMessageAction.id,
    "copilotz.core-schedules.dispatch-message",
  );
});
