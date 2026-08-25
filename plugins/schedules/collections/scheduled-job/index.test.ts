import { assertEquals } from "@std/assert";
import { scheduledJobCollection } from "./index.ts";

Deno.test("Scheduled Job Collection retains its canonical name", () => {
  assertEquals(scheduledJobCollection.name, "scheduled_job");
});
