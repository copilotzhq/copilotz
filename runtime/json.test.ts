import { assertEquals, assertThrows } from "@std/assert";
import { assertJsonValue } from "./json.ts";
import { durableActionMetadata, durableActionValue } from "./actions/value.ts";

Deno.test("JSON boundary matrix preserves explicit omission, number and binary policies", () => {
  const cases = [
    { value: { a: undefined }, strict: false, codec: true },
    { value: -0, strict: false, codec: true },
    { value: NaN, strict: false, codec: false },
    { value: Infinity, strict: false, codec: false },
    { value: [undefined], strict: false, codec: false },
    { value: new Array(1), strict: false, codec: false },
    { value: new Date(), strict: false, codec: false },
    { value: new Uint8Array([1]), strict: false, codec: false },
    { value: { nested: [null, true, "text", 1] }, strict: true, codec: true },
  ];
  for (const test of cases) {
    for (const mode of ["strict", "codec"] as const) {
      const check = () =>
        assertJsonValue(test.value, {
          rejectNegativeZero: mode === "strict",
          omitUndefinedProperties: mode === "codec",
        });
      if (test[mode]) check();
      else assertThrows(check, TypeError);
    }
  }
  assertJsonValue(new Uint8Array([1]), { allowBytes: true });
  assertThrows(
    () => assertJsonValue({ a: { b: 1 } }, { maxDepth: 1 }),
    TypeError,
  );
  assertEquals(durableActionMetadata({ number: -0 }), { number: 0 });
  assertThrows(() => durableActionMetadata({ a: undefined }), TypeError);
  // Ordinary Action values retain their established JSON serialization semantics.
  assertEquals(durableActionValue({ a: undefined, b: NaN, c: [undefined] }), {
    b: null,
    c: [null],
  });
});

Deno.test("JSON validation rejects cycles, accessors and hidden or extra properties without evaluating them", () => {
  let reads = 0;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const extra = Object.assign([1], { extra: 2 });
  for (
    const value of [
      getter,
      cycle,
      extra,
      { [Symbol("hidden")]: 1 },
      Object.defineProperty({}, "hidden", { value: 1 }),
    ]
  ) {
    assertThrows(() => assertJsonValue(value), TypeError);
  }
  assertEquals(reads, 0);
  const shared = { a: 1 };
  assertJsonValue([shared, shared]);
});

Deno.test("durable Action values discard hydrated content reference fields", () => {
  assertEquals(
    durableActionValue({
      result: {
        assetId: "asset-a",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        value: "hydrated body",
        resolve: true,
        extra: "not durable",
        metadata: {
          nested: {
            assetId: "asset-b",
            kind: "json",
            role: "attachment",
            mediaType: "application/json",
            value: { hydrated: true },
          },
        },
      },
    }),
    {
      result: {
        assetId: "asset-a",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        metadata: {
          nested: {
            assetId: "asset-b",
            kind: "json",
            role: "attachment",
            mediaType: "application/json",
          },
        },
      },
    },
  );
});
