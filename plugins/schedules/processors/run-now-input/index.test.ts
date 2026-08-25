import { assertEquals } from "@std/assert";
import { scheduledJobRunNowInputProcessor } from "./index.ts";

Deno.test("run-now input Processor retains its canonical id", () => {
  assertEquals(scheduledJobRunNowInputProcessor.id, "schedules.run-now-input");
});
