import { assertEquals } from "@std/assert";
import { deleteThreadMessagesAction } from "./index.ts";
Deno.test("delete-thread-messages Action owns its identity", () =>
  assertEquals(
    deleteThreadMessagesAction.id,
    "copilotz.core.thread.deleteMessages",
  ));
