import { assertEquals, assertThrows } from "@std/assert";
import { createEphemeralEvent } from "./types.ts";

Deno.test("ephemeral Event data is an immutable exact JSON snapshot", () => {
  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "not-read";
    },
  });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  for (const payload of [new Uint8Array([1]), cyclic, accessor]) {
    assertThrows(
      () =>
        createEphemeralEvent({
          type: "test.data",
          namespace: "test",
          correlationId: "test-data",
          payload,
        }),
      TypeError,
      "strict JSON",
    );
  }
  assertEquals(getterReads, 0);

  const source = { nested: [{ value: 1 }] };
  const event = createEphemeralEvent({
    type: "test.data",
    namespace: "test",
    correlationId: "test-data",
    payload: source,
  });
  source.nested[0].value = 2;
  assertEquals(event.payload, { nested: [{ value: 1 }] });
  assertEquals(Object.isFrozen(event.payload), true);
  assertEquals(Object.isFrozen(event.payload.nested), true);
  assertEquals(Object.isFrozen(event.payload.nested[0]), true);
});
