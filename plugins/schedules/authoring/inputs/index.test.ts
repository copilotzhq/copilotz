import { assertEquals } from "@std/assert";
import { scheduleTick } from "./index.ts";

Deno.test("scheduleTick creates the canonical input envelope", () => {
  assertEquals(scheduleTick({ checkedAt: "2026-01-01T00:00:00.000Z" }), {
    type: "copilotz.schedules.tick.input",
    payload: { checkedAt: "2026-01-01T00:00:00.000Z" },
  });
});
