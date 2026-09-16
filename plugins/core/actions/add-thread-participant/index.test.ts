import { assertEquals } from "@std/assert";
import { addThreadParticipantAction } from "./index.ts";
Deno.test("add-thread-participant Action owns its identity", () =>
  assertEquals(
    addThreadParticipantAction.id,
    "copilotz.core.thread.addParticipant",
  ));
