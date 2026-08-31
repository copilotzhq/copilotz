import { assert, assertEquals } from "@std/assert";
import { createInvalidateMemoryAction } from "./index.ts";
Deno.test("invalidate action has a stable id and explicit output contract", () => {
  const action = createInvalidateMemoryAction();
  assertEquals(action.id, "copilotz.memory.invalidate");
  assert(action.outputSchema);
});
