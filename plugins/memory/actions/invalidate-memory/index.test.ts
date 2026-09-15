import { assert, assertEquals } from "@std/assert";
import { invalidateMemoryAction } from "./index.ts";
Deno.test("invalidate action has a stable id and explicit output contract", () => {
  const action = invalidateMemoryAction;
  assertEquals(action.id, "copilotz.memory.invalidate");
  assert(action.outputSchema);
});
