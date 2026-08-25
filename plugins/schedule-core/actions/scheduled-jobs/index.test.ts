import { assertEquals, assertExists } from "@std/assert";
import { scheduledJobsAction } from "./index.ts";

Deno.test("scheduledJobsAction owns its schema and identity", () => {
  assertEquals(
    scheduledJobsAction.id,
    "copilotz.core-schedules.scheduled-jobs",
  );
  assertExists(scheduledJobsAction.inputSchema);
});
