import { assertEquals } from "@std/assert";
import { scheduledJobsTickInputProcessor } from "./index.ts";

Deno.test("tick input Processor retains its canonical id", () => {
  assertEquals(scheduledJobsTickInputProcessor.id, "schedules.tick-input");
});
