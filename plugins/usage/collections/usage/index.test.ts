import { assertEquals } from "@std/assert";
import { usageCollection } from "./index.ts";

Deno.test("Usage Collection retains its canonical name", () => {
  assertEquals(usageCollection.name, "usage");
});
