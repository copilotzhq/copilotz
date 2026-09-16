import { assertEquals } from "@std/assert";
import { CORE_MESSAGE_INPUT_EVENT, message } from "./index.ts";
Deno.test("Message authoring creates the canonical input event", () => {
  assertEquals(
    message({ thread: "t", participant: "u", content: "hi" }).type,
    CORE_MESSAGE_INPUT_EVENT,
  );
});
