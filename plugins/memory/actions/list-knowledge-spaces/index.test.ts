import { assertEquals } from "@std/assert";
import { listKnowledgeSpacesAction } from "./index.ts";
Deno.test("space listing action is named", () =>
  assertEquals(
    listKnowledgeSpacesAction.id,
    "copilotz.memory.spaces.list",
  ));
