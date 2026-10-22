import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildCoreLlmRequest } from "./prompt.ts";

Deno.test("Core no-response guidance is independent of the tool protocol", async () => {
  const request = await buildCoreLlmRequest({
    resources: { agents: {}, promptInstructions: {} },
    collections: { message: { list: () => Promise.resolve([]) } },
    content: {
      getMany: () => Promise.resolve([]),
      resolveMany: () => Promise.resolve([]),
    },
  } as never, {
    agent: { id: "agent", name: "Agent", role: "assistant", models: {} },
    participant: {
      id: "agent",
      externalId: "agent",
      participantType: "agent",
      metadata: {},
    },
    thread: { id: "thread", participants: [], metadata: {} },
    history: [],
    messageIds: [],
    tools: [],
    frozenContributions: [],
  } as never);
  assertStringIncludes(request.instructions ?? "", "<no_response/>");
  assertEquals(request.tools, []);
});

Deno.test("Core without Memory never dumps human metadata into a prompt", async () => {
  const context = {
    resources: { agents: {}, promptInstructions: {} },
    collections: { message: { list: () => Promise.resolve([]) } },
    content: {
      getMany: () => Promise.resolve([]),
      resolveMany: () => Promise.resolve([]),
    },
  };
  const human = (id: string, value: string) => ({
    id,
    externalId: id,
    participantType: "human",
    metadata: { arbitrary: value, memories: { items: [{ content: value }] } },
  });
  const build = (value: string, shared: boolean) =>
    buildCoreLlmRequest(context as never, {
      agent: { id: "agent", name: "Agent", role: "assistant", models: {} },
      participant: {
        id: "agent",
        externalId: "agent",
        participantType: "agent",
        metadata: {},
      },
      thread: {
        id: "thread",
        participants: [
          human("first", value),
          ...(shared ? [human("initiator", value)] : []),
        ],
        metadata: {},
      },
      initiatorParticipantId: shared ? "initiator" : "first",
      history: [],
      messageIds: [],
      tools: [],
      frozenContributions: [],
    } as never);
  for (const shared of [false, true]) {
    const before = await build("PRIVATE_BEFORE", shared);
    const after = await build("PRIVATE_AFTER", shared);
    assertEquals(before, after);
    assertEquals(JSON.stringify(before).includes("PRIVATE_"), false);
    assertEquals(JSON.stringify(before).includes("USER METADATA"), false);
  }
});
