import { assert, assertEquals, assertThrows } from "@std/assert";
import { captureHostCommandJson } from "./host-command-json.ts";
Deno.test("host JSON captures deeply immutable bounded data without executing accessors", () => {
  const source = { nested: [1, { text: "ok" }] };
  const copy = captureHostCommandJson(source);
  source.nested[0] = 2;
  assertEquals(copy, { nested: [1, { text: "ok" }] });
  assert(Object.isFrozen(copy));
  assert(Object.isFrozen((copy as { nested: unknown[] }).nested));
  for (
    const invalid of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      new Uint8Array(1),
      () => {},
      new Array(2),
      { a: undefined },
      { [Symbol()]: 1 },
    ]
  ) {
    assertThrows(() => captureHostCommandJson(invalid));
  }
  let accessed = false;
  assertThrows(() =>
    captureHostCommandJson({
      get value() {
        accessed = true;
        return 1;
      },
    })
  );
  assertEquals(accessed, false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assertThrows(() => captureHostCommandJson(cycle));
  assertThrows(() => captureHostCommandJson("x".repeat(1024 * 1024)));
  assertEquals(
    captureHostCommandJson(JSON.parse('{"__proto__":{"value":1}}')),
    JSON.parse('{"__proto__":{"value":1}}'),
  );
});

Deno.test("recapture reuses only owned snapshots and still charges embedded budgets", () => {
  const original = { nested: { value: 1 } };
  const captured = captureHostCommandJson(original);
  assert(captureHostCommandJson(captured) === captured);
  original.nested.value = 2;
  assertEquals(captured, { nested: { value: 1 } });
  // Freezing caller state does not prove it is data-only.
  assertThrows(() =>
    captureHostCommandJson(Object.freeze({
      get value() {
        throw new Error("getter");
      },
    }))
  );
  assertThrows(() =>
    captureHostCommandJson(Object.freeze({ value: undefined }))
  );
  const bytes = captureHostCommandJson({ value: "x".repeat(600_000) });
  assertThrows(
    () => captureHostCommandJson([bytes, bytes]),
    RangeError,
    "1 MiB",
  );
  const nodes = captureHostCommandJson(Array(50_000).fill(0));
  assertThrows(
    () => captureHostCommandJson([nodes, nodes]),
    RangeError,
    "complex",
  );
  let deep: unknown = 0;
  for (let i = 0; i < 64; i++) deep = [deep];
  const depth = captureHostCommandJson(deep);
  assert(captureHostCommandJson(depth) === depth);
  assertThrows(() => captureHostCommandJson([depth]), RangeError, "complex");
  // A proxy cannot borrow the identity-based validation proof.
  assertThrows(() =>
    captureHostCommandJson(
      new Proxy(captured as object, {
        getPrototypeOf() {
          return null;
        },
      }),
    )
  );
});

Deno.test("nested owned snapshots retain their own byte, node and depth budgets", () => {
  const captured = captureHostCommandJson({
    first: { deep: { value: 1 } },
    last: { value: "x".repeat(600_000) },
  }) as { first: { deep: { value: number } }; last: { value: string } };
  assert(captureHostCommandJson(captured.first.deep) === captured.first.deep);
  assert(captureHostCommandJson(captured.last) === captured.last);
  assertThrows(
    () => captureHostCommandJson([captured.last, captured.last]),
    RangeError,
  );
  let limit: unknown = captured.first.deep;
  for (let i = 0; i < 63; i++) limit = [limit];
  captureHostCommandJson(limit);
  assertThrows(() => captureHostCommandJson([limit]), RangeError);
  const nodes = captureHostCommandJson({ nested: Array(50_000).fill(0) }) as {
    nested: number[];
  };
  assertThrows(
    () => captureHostCommandJson([nodes.nested, nodes.nested]),
    RangeError,
  );
});
