import { assertEquals, assertThrows } from "@std/assert";
import { defineLlmCredential } from "./index.ts";

Deno.test("defineLlmCredential normalizes static credentials", () => {
  assertEquals(defineLlmCredential({ provider: "openai", apiKey: " key " }), {
    provider: "openai",
    apiKey: "key",
  });
  assertThrows(() => defineLlmCredential({ provider: "openai" } as never));
});
