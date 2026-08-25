import { assertEquals } from "@std/assert";
import { createUpdateMyMemoryAction } from "../../actions/update-my-memory/index.ts";
import { createUpdateMyMemoryToolResource } from "./index.ts";
Deno.test("Agent-memory Resource exposes its alias", () =>
  assertEquals(
    createUpdateMyMemoryToolResource(createUpdateMyMemoryAction()).action,
    "update_my_memory",
  ));
