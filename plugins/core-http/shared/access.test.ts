import { assertEquals, assertThrows } from "@std/assert";
import { type ActionContext, ActionError } from "@copilotz/copilotz/actions";
import { actor } from "./access.ts";

Deno.test("Core conversation mutations refuse missing actors with actor_required", () => {
  const error = assertThrows(
    () => actor({ action: { metadata: {} } } as ActionContext),
    ActionError,
  );
  assertEquals(error.status, 403);
  assertEquals(error.code, "actor_required");
});
