import { assert, assertEquals } from "@std/assert";
import { message } from "@copilotz/copilotz/core";
import { nativeChatFixture as fixture } from "../testing/native-chat.ts";

const sender = {
  id: "sender",
  externalId: "sender",
  participantType: "human" as const,
};
const human = {
  id: "human",
  externalId: "human",
  participantType: "human" as const,
};
const agent = {
  id: "agent",
  externalId: "assistant",
  participantType: "agent" as const,
  agentId: "assistant",
};

for (const recipientIds of [["human"], ["agent"], ["human", "agent"]]) {
  Deno.test(`explicit ${recipientIds.join("+")} recipients settle via creation and message input`, async () => {
    const f = await fixture();
    await f.invoke("login", {});
    try {
      await f.invoke("createThread", {
        id: "thread",
        participants: [sender, human, agent],
      });
      await f.invoke("createThreadMessage", {
        id: "direct",
        threadId: "thread",
        sender,
        recipientIds,
        content: "Direct message",
      });
      await f.settled();
      const sent = await f.app.send(
        message({
          thread: { id: "thread" },
          participant: sender,
          recipientIds,
          content: "Input message",
        }),
      );
      await sent.done;
      await f.settled();
      const messages = await f.records("message");
      const inputs = messages.filter((item) => item.senderId === "sender");
      assertEquals(inputs.length, 2);
      for (const input of inputs) {
        assertEquals(input.recipientIds, recipientIds);
      }
      const expected = recipientIds.includes("agent") ? 2 : 0;
      assertEquals(f.calls, expected);
      assertEquals(
        messages.filter((item) => item.senderId === "agent").length,
        expected,
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test("native-session first chat with owner policies closes snapshots and stores the Agent reply", async () => {
  const f = await fixture();
  try {
    await f.invoke("login", {});
    assert(f.cookie);
    assertEquals(await f.records("participant"), []);
    await f.invoke("createThread", {
      id: "thread",
      participants: [sender, agent],
    });
    await f.invoke("createThreadMessage", {
      id: "first",
      threadId: "thread",
      sender,
      recipientIds: ["agent"],
      content: "First question",
    });
    await f.settled();
    assertEquals(f.calls, 1);
    const replies = (await f.records("message")).filter((item) =>
      item.senderId === "agent"
    );
    assertEquals(replies.length, 1);
    // A second turn also proves the first snapshot released its physical capacity.
    await f.invoke("createThreadMessage", {
      id: "second",
      threadId: "thread",
      sender,
      recipientIds: ["agent"],
      content: "Second question",
    });
    await f.settled();
    assertEquals(f.calls, 2);
  } finally {
    await f.close();
  }
});
