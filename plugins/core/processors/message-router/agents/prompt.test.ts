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
