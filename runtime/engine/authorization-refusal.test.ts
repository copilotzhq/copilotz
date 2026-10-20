import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ActionError } from "../actions/errors.ts";
import {
  isOwnerAuthorizationRefusal,
  withOwnerPolicyRefusal,
} from "./authorization-refusal.ts";
Deno.test("owner refusal classification requires trusted explicit denial and preserves synchronous return lifetime", async () => {
  assertEquals(withOwnerPolicyRefusal(() => "sync"), "sync");
  for (
    const error of [
      new Error("database unavailable"),
      Object.assign(new Error("forbidden"), { code: "forbidden", status: 403 }),
    ]
  ) {
    assertThrows(() =>
      withOwnerPolicyRefusal(() => {
        throw error;
      })
    );
    assertEquals(isOwnerAuthorizationRefusal(error), false);
  }
  const forbidden = new ActionError("denied", {
    code: "forbidden",
    status: 403,
  });
  await assertRejects(() =>
    withOwnerPolicyRefusal(() => Promise.reject(forbidden))
  );
  assertEquals(isOwnerAuthorizationRefusal(forbidden), true);
  const cancellation = new AbortController();
  cancellation.abort();
  const aborted = new ActionError("denied", { code: "forbidden", status: 403 });
  assertThrows(() =>
    withOwnerPolicyRefusal(() => {
      throw aborted;
    }, cancellation.signal)
  );
  assertEquals(isOwnerAuthorizationRefusal(aborted), false);
});
