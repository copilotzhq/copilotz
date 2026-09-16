import { assertEquals } from "@std/assert";
import { participantCollection } from "./index.ts";
Deno.test("Participant Collection owns its name", () =>
  assertEquals(participantCollection.name, "participant"));
