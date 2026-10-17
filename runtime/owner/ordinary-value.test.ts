import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";

test("ordinary owner values refuse reserved protected families and partial references", () => {
  for (
    const family of [
      "copilotz.event.protected-value",
      "copilotz.action.lifecycle.protected",
      "copilotz.action.protected-value",
      "copilotz.action.protected-value-aad",
    ]
  ) {
    for (const suffix of ["", ".", ".v1", ".v2", ".malformed"]) {
      for (const schema of [`${family}${suffix}`, [[`${family}${suffix}`]]]) {
        assert.throws(
          () => assertOwnerOrdinaryValue({ nested: [{ schema }] }),
          /ordinary_value_unsupported/,
        );
      }
    }
  }
  for (
    const key of [
      "assetId",
      "bodyId",
      "ownerNodeId",
      "location",
      "$copilotz-secret",
      "$copilotz-protected",
      "x-copilotz-secret",
    ]
  ) {
    assert.throws(
      () => assertOwnerOrdinaryValue({ nested: [{ [key]: null }] }),
      /ordinary_value_unsupported/,
    );
  }
});
test("ordinary owner values retain ordinary JSON and exact family boundaries", () => {
  const shared = { text: "ordinary" };
  for (
    const value of [
      null,
      false,
      3,
      "copilotz.action.lifecycle.protected.v2",
      [shared, shared],
      Object.assign(Object.create(null), { text: "safe" }),
      { schema: "app.copilotz.action.protected-value.v2" },
      { schema: "copilotz.action.lifecycle.protectedness.v2" },
    ]
  ) {
    assert.doesNotThrow(() => assertOwnerOrdinaryValue(value));
  }
});
test("ordinary owner values reject capabilities without getters or schema coercion", () => {
  let invoked = 0;
  const accessor = {
    get schema() {
      invoked++;
      return "safe";
    },
  };
  const coercion = {
    schema: {
      toString() {
        invoked++;
        return "safe";
      },
    },
  };
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (
    const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      Symbol("value"),
      () => null,
      new Date(),
      new Map(),
      new AbortController().signal,
      accessor,
      coercion,
      cyclic,
      { [Symbol("key")]: null },
      Object.defineProperty({}, "hidden", { value: "hidden" }),
      Array(2),
      Object.assign([], { extra: true }),
    ]
  ) {
    assert.throws(
      () => assertOwnerOrdinaryValue(value),
      /ordinary_value_unsupported/,
    );
  }
  assert.equal(invoked, 0);
});
test("ordinary owner value traversal has finite depth and node bounds", () => {
  let value: unknown = null;
  for (let index = 0; index < 32; index++) value = { value };
  assert.doesNotThrow(() => assertOwnerOrdinaryValue(value));
  assert.throws(
    () => assertOwnerOrdinaryValue({ value }),
    /ordinary_value_unsupported/,
  );
  assert.doesNotThrow(() => assertOwnerOrdinaryValue(Array(19_999).fill(null)));
  assert.throws(
    () => assertOwnerOrdinaryValue(Array(20_000).fill(null)),
    /ordinary_value_unsupported/,
  );
});
