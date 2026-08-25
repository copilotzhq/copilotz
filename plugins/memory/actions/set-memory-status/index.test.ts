import { assertEquals } from "@std/assert";
import { createSetMemoryStatusAction } from "./index.ts";
Deno.test("status action is named", () =>
  assertEquals(createSetMemoryStatusAction().id, "copilotz.memory.status.set"));
