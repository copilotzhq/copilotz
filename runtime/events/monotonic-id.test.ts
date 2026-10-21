import { assertEquals } from "@std/assert";
import { monotonicUlid } from "../../dependencies/ulid.ts";

Deno.test("generated ULIDs are unique and ordered within one process millisecond", () => {
  const time = Date.now();
  const ids = Array.from({ length: 1000 }, () => monotonicUlid(time));
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(ids, [...ids].sort());
  assertEquals(new Set(ids.map((id) => id.slice(0, 10))).size, 1);
});
