import { assertEquals } from "@std/assert";
import { memoryReservationProcessor } from "./index.ts";
Deno.test("reservation processor is named", () =>
  assertEquals(
    memoryReservationProcessor.id,
    "copilotz.memory.reserve",
  ));
