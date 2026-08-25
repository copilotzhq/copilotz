import { assertEquals } from "@std/assert";
import { createListKnowledgeSpacesAction } from "./index.ts";
Deno.test("space listing action is named", () =>
  assertEquals(
    createListKnowledgeSpacesAction().id,
    "copilotz.memory.spaces.list",
  ));
