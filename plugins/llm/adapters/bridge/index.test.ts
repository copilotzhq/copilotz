import { assertThrows } from "@std/assert";
import { validateBuiltinProviderCall } from "./index.ts";

Deno.test("provider bridge rejects unsupported built-in session mode", () => {
  assertThrows(() => validateBuiltinProviderCall("openai", "session", {}));
});
