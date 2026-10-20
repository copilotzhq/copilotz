import { assertEquals, assertThrows } from "@std/assert";
import { mergePipelineArguments } from "../jq.ts";

Deno.test("jq argument merge retains explicit nested values and protected keys", () => {
  const source = { nested: { left: 1, right: 2 }, array: [1] };
  assertEquals(
    mergePipelineArguments(source, { nested: { right: 3 }, array: [2] }),
    { nested: { left: 1, right: 3 }, array: [2] },
  );
  assertEquals(source, { nested: { left: 1, right: 2 }, array: [1] });
  assertThrows(() => mergePipelineArguments([], {}), Error, "plain object");
  for (const key of ["__proto__", "prototype", "constructor"]) {
    assertThrows(
      () => mergePipelineArguments({}, JSON.parse(`{"${key}":1}`)),
      Error,
      "not allowed",
    );
  }
});
