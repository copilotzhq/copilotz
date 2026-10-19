import { assertEquals, assertThrows } from "@std/assert";
import { ActionError, standardActionError } from "../actions/errors.ts";
import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { collectionPolicyRefused } from "../authorization/collection.ts";

Deno.test("Collection planning and policy refusal share presentation, not cleanup authority", () => {
  const planning = assertThrows(
    () => collectionPolicyRefused(false),
    ActionError,
  );
  const policy = assertThrows(() => collectionPolicyRefused(), ActionError);
  const present = (error: ActionError) => ({
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
  });
  assertEquals(present(planning), present(policy));
  assertEquals(present(planning), present(standardActionError(policy)!));
  assertEquals(isOwnerAuthorizationRefusal(planning), false);
  assertEquals(isOwnerAuthorizationRefusal(policy), true);
  assertEquals(isOwnerAuthorizationRefusal({ ...policy }), false);
});
