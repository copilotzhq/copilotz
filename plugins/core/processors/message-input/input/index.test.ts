import { assertEquals } from "@std/assert";
import { CORE_MESSAGE_INPUT_EVENT, message } from "./index.ts";
Deno.test("Message authoring creates the canonical input event", () => {
  assertEquals(
    message({ thread: "t", participant: "u", content: "hi" }).type,
    CORE_MESSAGE_INPUT_EVENT,
  );
});

Deno.test("Message ingress indexes known Thread ids and preserves Core visibility", () => {
  for (const thread of ["thread", { id: "thread" }]) {
    const envelope = message({
      thread,
      participant: "u",
      content: "hi",
      visibility: { kind: "internal" },
    });
    assertEquals(envelope.metadata, {
      observationKeys: ["core.thread:thread"],
      core: { threadId: "thread", visibility: { kind: "internal" } },
    });
  }
  const unresolved = message({
    thread: { externalId: "outside" },
    participant: "u",
    content: "hi",
  });
  assertEquals(unresolved.metadata, undefined);
});
