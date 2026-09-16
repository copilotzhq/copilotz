import { assertEquals } from "@std/assert";
import { setMemoryStatusAction } from "./index.ts";
Deno.test("status action is named", () =>
  assertEquals(setMemoryStatusAction.id, "copilotz.memory.status.set"));
