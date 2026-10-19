import { assertEquals, assertThrows } from "@std/assert";
import {
  canonicalJson,
  chargeJsonString,
  orderedJson,
} from "./data-only-json.ts";

Deno.test("JSON string charges match escaped UTF-8 for every UTF-16 code unit", () => {
  const encoder = new TextEncoder();
  const check = (value: string) => {
    let bytes = 0;
    assertEquals(chargeJsonString(value, Infinity, (n) => bytes += n), value);
    assertEquals(bytes, encoder.encode(JSON.stringify(value)).length);
  };
  for (let code = 0; code <= 0xffff; code++) check(String.fromCharCode(code));
  for (
    const value of [
      "",
      '"\\\b\t\n\f\r\u0000',
      "ASCII café 水 😀",
      "\ud800\udc00",
      "\udbff\udfff",
      "\ud800x\udc00",
      "\ud800\ud800\udc00\udc00",
      "\u2028\u2029",
      "x".repeat(4096),
    ]
  ) check(value);
});

Deno.test("JSON string charges preserve exact inclusive limits and stop on overflow", () => {
  for (const value of ["", "ab", "\u0000", "\ud800", "水", "😀", '"\\']) {
    const size = new TextEncoder().encode(JSON.stringify(value)).length;
    const chargeWith = (limit: number) => {
      let remaining = limit;
      chargeJsonString(value, remaining, (bytes) => {
        remaining -= bytes;
        if (remaining < 0) throw new RangeError("budget");
      });
      return remaining;
    };
    assertEquals(chargeWith(size), 0);
    assertEquals(chargeWith(size + 1), 1);
    assertThrows(() => chargeWith(size - 1), RangeError, "budget");
  }
  let calls = 0;
  assertThrows(() =>
    chargeJsonString("x".repeat(100_000), 10, () => {
      calls++;
      throw new RangeError("budget");
    })
  );
  assertEquals(calls, 1);
});

Deno.test("canonical JSON preserves historical textual and object ordering formats", () => {
  const value = { "2": "two", "10": "ten", z: -0, a: [null, true] };
  assertEquals(
    canonicalJson(value),
    '{"10":"ten","2":"two","a":[null,true],"z":0}',
  );
  assertEquals(
    canonicalJson(value, { objectOrder: true }),
    '{"2":"two","10":"ten","a":[null,true],"z":0}',
  );
  assertEquals(
    canonicalJson({ Z: 1, a: 2, "é": 3 }, {
      order: "locale",
      objectOrder: true,
    }),
    '{"a":2,"é":3,"Z":1}',
  );
  assertEquals(
    canonicalJson({ a: undefined }, { undefinedValue: "undefined" }),
    '{"a":undefined}',
  );
  assertEquals(
    canonicalJson({ a: undefined }, { undefinedValue: "null" }),
    '{"a":null}',
  );
  assertEquals(canonicalJson({ a: undefined }, { objectOrder: true }), "{}");
  assertEquals(
    JSON.stringify(orderedJson(JSON.parse('{"__proto__":{"safe":true}}'))),
    '{"__proto__":{"safe":true}}',
  );
});

Deno.test("shared canonical encoding never invokes object or array accessors or toJSON", () => {
  let calls = 0;
  const getter = {
    get value() {
      calls++;
      return 1;
    },
  };
  const array = Object.defineProperty([], "0", {
    get() {
      calls++;
      return 1;
    },
    enumerable: true,
  });
  const hooks = {
    toJSON() {
      calls++;
      return {};
    },
  };
  for (const value of [getter, array, hooks]) {
    assertThrows(() => canonicalJson(value), TypeError);
    assertThrows(() => canonicalJson(value, { objectOrder: true }), TypeError);
  }
  assertEquals(calls, 0);
});
