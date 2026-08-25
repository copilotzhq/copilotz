import { assertEquals } from "@std/assert";
import { dispatchScheduledMessageProcessor } from "./index.ts";

Deno.test("dispatchScheduledMessageProcessor owns the due-event matcher", () => {
  assertEquals(
    dispatchScheduledMessageProcessor.id,
    "core-schedules.dispatch-message",
  );
  assertEquals(
    dispatchScheduledMessageProcessor.on[0].eventType,
    "scheduled_job.due",
  );
});
