import { assertEquals } from "@std/assert";
import { ollamaProvider } from "./index.ts";

Deno.test("Ollama adapter exposes a provider factory", () => {
  assertEquals(typeof ollamaProvider, "function");
});
