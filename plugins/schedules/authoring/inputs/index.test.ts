import { assertEquals } from "@std/assert";
import { runScheduledJobNow } from "./index.ts";

Deno.test("manual schedule input retains its canonical envelope", () => {
  assertEquals(
    runScheduledJobNow({ id: "job", scheduledFor: "2026-01-01T00:00:00.000Z" }),
    {
      type: "copilotz.schedules.run-now.input",
      payload: { id: "job", scheduledFor: "2026-01-01T00:00:00.000Z" },
    },
  );
});
