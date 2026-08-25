import { assertStrictEquals } from "@std/assert";
import { createLlmAdapter } from "./index.ts";

Deno.test("createLlmAdapter preserves the executable call boundary", () => {
  const call = () => {
    throw new Error("not called");
  };
  assertStrictEquals(createLlmAdapter({ call }).call, call);
});
