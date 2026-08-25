import { assertEquals } from "@std/assert";
import { deepseekProvider } from "./index.ts";

Deno.test("DeepSeek adapter exposes a provider factory", () => {
  assertEquals(typeof deepseekProvider, "function");
});
