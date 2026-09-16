import { assertEquals } from "@std/assert";
import { coreHttpPlugin } from "./index.ts";
Deno.test("Core HTTP owns four mutations and one optional transport", () => {
  assertEquals(Object.keys(coreHttpPlugin.actions).length, 4);
  assertEquals(Object.keys(coreHttpPlugin.adapters.http), ["core"]);
});
