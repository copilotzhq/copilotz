import { assertEquals } from "@std/assert";
import { createUpdateUserMemoryAction } from "../../actions/update-user-memory/index.ts";
import { createUpdateUserMemoryToolResource } from "./index.ts";
Deno.test("human-memory Resource exposes its alias", () =>
  assertEquals(
    createUpdateUserMemoryToolResource(
      createUpdateUserMemoryAction(() => new Date()),
    ).action,
    "update_user_memory",
  ));
