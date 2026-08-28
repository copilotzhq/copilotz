import { assertEquals, assertThrows } from "@std/assert";
import { createWebChannelAdapter } from "./index.ts";

Deno.test("Web Channel Adapter accepts one occurrence", async () => {
  const accepted = await createWebChannelAdapter().accept({
    method: "POST",
    headers: {},
    body: { id: "web-1", input: { hello: "world" } },
  }, {} as never);
  assertEquals(accepted.status, 202);
  assertEquals(accepted.occurrences, [{
    id: "web-1",
    input: { hello: "world" },
  }]);
});

Deno.test("Web Channel Adapter normalizes declared thread participants", async () => {
  const received = await createWebChannelAdapter().receive({
    externalThreadId: "web-thread-1",
    sender: {
      externalId: "user",
      participantType: "human",
    },
    recipients: ["north"],
    content: "hello",
    thread: {
      participants: [
        "north",
        { externalId: "south", participantType: "human", name: "South" },
      ],
    },
  }, {} as never);
  assertEquals(received.thread?.participants, [
    "north",
    { externalId: "south", participantType: "human", name: "South" },
  ]);
  assertEquals(Object.isFrozen(received.thread), true);
  assertEquals(Object.isFrozen(received.thread?.participants), true);
  assertEquals(Object.isFrozen(received.thread?.participants?.[1]), true);
});

Deno.test("Web Channel Adapter rejects non-array declared thread participants", () => {
  assertThrows(
    () =>
      createWebChannelAdapter().receive({
        externalThreadId: "web-thread-1",
        sender: { externalId: "user", participantType: "human" },
        recipients: ["north"],
        content: "hello",
        thread: { participants: "north" },
      }, {} as never),
    TypeError,
    "participants must be an array",
  );
});
