import { assertEquals } from "@std/assert";
import { messageCollection } from "./index.ts";
Deno.test("Message Collection owns its name", () =>
  assertEquals(messageCollection.name, "message"));
