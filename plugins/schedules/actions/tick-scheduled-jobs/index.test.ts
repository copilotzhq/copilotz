import { assertEquals } from "@std/assert";
import { tickScheduledJobsAction } from "./index.ts";

Deno.test("tick Action retains its canonical id", () => {
  assertEquals(tickScheduledJobsAction.id, "copilotz.schedules.tick");
});
