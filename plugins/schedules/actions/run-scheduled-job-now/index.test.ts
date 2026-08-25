import { assertEquals } from "@std/assert";
import { runScheduledJobNowAction } from "./index.ts";

Deno.test("run-now Action retains its canonical id", () => {
  assertEquals(runScheduledJobNowAction.id, "copilotz.schedules.run-now");
});
