import { assert, assertThrows } from "@std/assert";
import { compileLiveFilters, POLICY_PREDICATE_LIMITS } from "./predicate.ts";

const schema = {
  type: "object",
  properties: {
    status: { enum: ["active", "archived"] },
    kind: { const: "space" },
    tags: { enum: [["a"], ["b"]] },
    ownerId: { type: "string" },
  },
};

Deno.test("live where accepts untyped scalar enum and const fields", () => {
  const match = compileLiveFilters(
    [{ where: { status: "active", kind: "space" } }],
    POLICY_PREDICATE_LIMITS,
    schema,
    { trusted: true },
  );
  assert(match({ id: "s1", status: "active", kind: "space" } as never));
  assert(!match({ id: "s2", status: "archived", kind: "space" } as never));
});

Deno.test("live where still refuses an enum of non-scalar values", () => {
  assertThrows(() =>
    compileLiveFilters(
      [{ where: { tags: "a" } }],
      POLICY_PREDICATE_LIMITS,
      schema,
      { trusted: true },
    )
  );
});
