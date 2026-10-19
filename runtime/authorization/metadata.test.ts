import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  captureOperationConstraints,
  matchesOperationConstraints,
} from "./metadata.ts";

Deno.test("ordinary ownership preserves explicit absence across JSON serialization", () => {
  const policy = captureOperationConstraints({
    metadata: { actorId: "api:key-1" },
    absentMetadata: ["computerOperationKind"],
  });
  const wire = JSON.parse(JSON.stringify(policy));
  assert(
    matchesOperationConstraints({ actorId: "api:key-1", extra: true }, wire),
  );
  for (const kind of [null, undefined, "computer"]) {
    assert(
      !matchesOperationConstraints({
        actorId: "api:key-1",
        computerOperationKind: kind,
      }, wire),
    );
  }
  assert(!matchesOperationConstraints({ actorId: "creator" }, wire));
  assert(
    matchesOperationConstraints({
      actorId: "api:key-1",
      computerOperationKind: null,
    }, { metadata: { actorId: "api:key-1" } }),
  );
});

Deno.test("operation metadata equality is structural and requires own keys", () => {
  const policy = captureOperationConstraints({
    metadata: { access: { a: 1, b: 2 }, empty: null },
  });
  assert(
    matchesOperationConstraints({
      access: { b: 2, a: 1 },
      empty: null,
      extra: 1,
    }, policy),
  );
  assert(!matchesOperationConstraints({ access: { a: 1, b: 2 } }, policy));
  assert(
    !matchesOperationConstraints(
      Object.create({ access: { a: 1, b: 2 }, empty: null }),
      policy,
    ),
  );
  assertEquals(matchesOperationConstraints(null, policy), false);
});

Deno.test("operation constraints reject lossy undefined and contradictory absence", () => {
  assertThrows(() =>
    captureOperationConstraints({
      metadata: { computerOperationKind: undefined },
    })
  );
  assertThrows(() =>
    captureOperationConstraints({
      metadata: { kind: null },
      absentMetadata: ["kind"],
    })
  );
  assertThrows(() =>
    captureOperationConstraints({
      metadata: {},
      absentMetadata: ["kind", "kind"],
    })
  );
  assertThrows(() =>
    captureOperationConstraints({ metadata: {}, absentMetadata: [""] })
  );
});
