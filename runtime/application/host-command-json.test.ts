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
