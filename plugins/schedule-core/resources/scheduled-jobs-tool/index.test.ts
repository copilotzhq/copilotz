import { assertEquals } from "@std/assert";
import { scheduledJobsToolResource } from "./index.ts";

Deno.test("scheduledJobsToolResource targets its owned Action alias", () => {
  assertEquals(scheduledJobsToolResource.action, "scheduled_jobs");
  assertEquals(scheduledJobsToolResource.name, "Scheduled Jobs");
});
