import { assertEquals } from "@std/assert";
import { groqProvider } from "./index.ts";

Deno.test("Groq adapter exposes a provider factory", () => {
  assertEquals(typeof groqProvider, "function");
});
