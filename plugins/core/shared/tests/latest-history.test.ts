import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createCopilotzApplication } from "../../../../runtime/application/application.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { definePlugin } from "../../../../runtime/plugins/index.ts";
import {
  type AgentResource,
  corePlugin,
  defineAgent,
  message,
} from "@copilotz/copilotz/core";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterFrame,
  LlmAdapterResult,
} from "@copilotz/copilotz/llm";
import { createTestDomainContext } from "../testing/context.ts";

const namespace = "latest-history";

function adapter(inputs: LlmAdapterCallInput[]): LlmAdapter {
  return {
    call(input) {
      inputs.push(input);
      const result: Promise<LlmAdapterResult> = Promise.resolve({
        content: { type: "text", text: "ok", role: "body" },
        attempts: [{ status: "completed" }],
      });
      return {
        frames: new ReadableStream<LlmAdapterFrame>({
          async start(controller) {
            await result;
            controller.close();
          },
        }),
        result,
      };
    },
  };
}

function prompt(input: LlmAdapterCallInput): string {
  return input.request.messages.flatMap((message) =>
    message.content.map((part) => part.type === "text" ? part.text : "")
  ).join("\n");
}

async function fixture(instructions?: AgentResource["instructions"]) {
  const db = await createTestDatabase({ url: ":memory:" });
  const inputs: LlmAdapterCallInput[] = [];
  const app = definePlugin({
    id: "test.latest-history",
    version: "1.0.0",
    resources: {
      agents: {
        north: defineAgent({
          id: "north",
          name: "North",
          role: "assistant",
          instructions,
          models: { generate: [{ connection: "model", model: "test" }] },
        }),
      },
      llmConnections: { model: { adapter: "test" } },
    },
    adapters: { llm: { test: adapter(inputs) } },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace,
    databaseSchema: "latest_history",
    plugins: [corePlugin, app],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  const domain = createTestDomainContext(application, namespace);
  await domain.actions.createThread({
    id: "thread",
    participants: [
      { id: "user", externalId: "user", participantType: "human" },
      {
        id: "north",
        externalId: "north",
        participantType: "agent",
        agentId: "north",
      },
      { id: "other", externalId: "other", participantType: "human" },
    ],
  });
  return {
    application,
    domain,
    inputs,
    async close() {
      await application.shutdown();
      await db.close();
    },
  };
}

Deno.test("real Core route selects latest public history across more than one page", async () => {
  const test = await fixture();
  try {
    // These durable messages do not target the Agent, so only the final send
    // invokes LLM while its route must page the complete thread history.
    for (let index = 0; index < 1_005; index++) {
      await test.domain.actions.createThreadMessage({
        id: `old-${index}`,
        threadId: "thread",
        sender: { id: "user", externalId: "user", participantType: "human" },
        content: `old-${index}`,
      });
    }
    await test.domain.actions.createThreadMessage({
      id: "private-other",
      threadId: "thread",
      sender: { id: "other", externalId: "other", participantType: "human" },
      recipientIds: ["other"],
      visibility: { kind: "participants", participantIds: ["other"] },
      content: "PRIVATE-OTHER",
    });
    const sent = await test.application.send(message({
      thread: "thread",
      participant: "user",
      recipientIds: ["north"],
      content: "newest-trigger",
    }));
    await sent.done;
    assert(test.inputs.length >= 1);
    const seen = prompt(test.inputs.at(-1)!);
    assertStringIncludes(seen, "old-0");
    assertStringIncludes(seen, "old-1004");
    assertStringIncludes(seen, "newest-trigger");
    assert(!seen.includes("PRIVATE-OTHER"));
  } finally {
    await test.close();
  }
});

Deno.test("removing an Agent during preparation prevents the uncaptured model invocation", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const test = await fixture({
    resolve: async () => {
      entered.resolve();
      await resume.promise;
      return { instructions: "ready" };
    },
  });
  try {
    const sent = await test.application.send(
      message({
        thread: "thread",
        participant: "user",
        recipientIds: ["north"],
        content: "start",
      }),
    );
    await entered.promise;
    await test.domain.collections.thread.update({
      id: "thread",
      set: { participantIds: ["user", "other"] },
    });
    resume.resolve();
    await sent.done;
    assertEquals(test.inputs.length, 0);
  } finally {
    resume.resolve();
    await test.close();
  }
});
