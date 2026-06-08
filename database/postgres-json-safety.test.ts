import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { sanitizePostgresParams } from "./postgres-json-safety.ts";

Deno.test("sanitizePostgresParams removes NUL chars from nested strings and keys", () => {
  const params = sanitizePostgresParams([
    {
      "bad\u0000key": "a\u0000b",
      nested: ["c\\u0000d", { value: "e\u0000f" }],
    },
  ]);

  assertEquals(params, [{
    badkey: "ab",
    nested: ["cd", { value: "ef" }],
  }]);
});

Deno.test("sanitizePostgresParams preserves binary params and dates", () => {
  const bytes = new Uint8Array([0, 1, 2]);
  const date = new Date("2026-06-08T00:00:00.000Z");
  const params = sanitizePostgresParams([bytes, date]);

  assertStrictEquals(params?.[0], bytes);
  assertStrictEquals(params?.[1], date);
});

Deno.test("sanitizePostgresParams replaces circular references", () => {
  const value: Record<string, unknown> = { name: "root" };
  value.self = value;

  assertEquals(sanitizePostgresParams([value]), [{
    name: "root",
    self: "[Circular]",
  }]);
});
