import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeOwnerMetadataConstraints as decode,
  encodeOwnerMetadataConstraints as encode,
  matchesOwnerMetadataConstraints as matches,
} from "./metadata-constraints.ts";

test("metadata restrictions preserve explicit absence across JSON transport", () => {
  const encoded = JSON.parse(
    JSON.stringify(
      encode({
        actorId: "actor",
        computerOperationKind: undefined,
        nullValue: null,
      }),
    ),
  );
  assert.deepEqual(encoded, {
    values: { actorId: "actor", nullValue: null },
    absentKeys: ["computerOperationKind"],
  });
  assert(matches(encoded, { actorId: "actor", nullValue: null, extra: true }));
  assert(
    !matches(encoded, {
      actorId: "actor",
      nullValue: null,
      computerOperationKind: null,
    }),
  );
  assert(
    !matches(encoded, {
      actorId: "actor",
      nullValue: null,
      computerOperationKind: undefined,
    }),
  );
  assert(!matches(encoded, { actorId: "actor" }));
  assert(!matches(encoded, { actorId: "other", nullValue: null }));
  assert(matches(encode({}), { computerOperationKind: "present" }));
});

test("metadata constraint wire rejects malformed or contradictory restrictions", () => {
  for (
    const value of [
      { values: {} },
      { values: {}, absentKeys: ["x", "x"] },
      { values: { x: null }, absentKeys: ["x"] },
      { values: {}, absentKeys: [1] },
      { values: [], absentKeys: [] },
      { values: {}, absentKeys: [], extra: true },
    ]
  ) {
    assert.throws(() => decode(value));
  }
  assert.throws(() => encode({ nested: { lost: undefined } }));
  assert.throws(() => encode({ huge: "x".repeat(70_000) }));
  let reads = 0;
  assert.throws(() =>
    encode({
      get secret() {
        reads++;
        return "x";
      },
    })
  );
  assert.equal(reads, 0);
});

test("metadata constraint snapshots are independent and structural equality ignores key ordering", () => {
  const source = { nested: { b: 2, a: 1 }, absent: undefined };
  const encoded = encode(source);
  source.nested.a = 9;
  assert(matches(encoded, { nested: { a: 1, b: 2 } }));
  const decoded = decode(encoded);
  (decoded.values.nested as Record<string, unknown>).a = 20;
  assert(matches(encoded, { nested: { a: 1, b: 2 } }));
  assert(!matches(encoded, null));
  const special = encode(JSON.parse('{"__proto__":null}'));
  assert(matches(special, JSON.parse('{"__proto__":null}')));
  assert(!matches(special, {}));
});
