import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { definePlugin } from "@copilotz/copilotz/plugins";
import type {
  LlmAdapter,
  LlmAdapterCallInput,
  LlmAdapterFrame,
  LlmAdapterResult,
} from "@copilotz/copilotz/llm";
import { createCopilotzApplication } from "../../../../runtime/application/application.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { defineAgent } from "../../authoring/define-agent/index.ts";
import { corePlugin } from "../../plugin.ts";
import { createTestDomainContext } from "../../shared/testing/context.ts";
import { CORE_MESSAGE_INPUT_EVENT, message } from "./input/index.ts";
import { messageInputProcessor } from "./index.ts";

function adapter(inputs: LlmAdapterCallInput[]): LlmAdapter {
  return {
    call(input) {
      inputs.push(input);
      const result: Promise<LlmAdapterResult> = Promise.resolve({
        content: { type: "text", text: "offline reply", role: "body" },
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
  return input.request.messages.flatMap((item) =>
    item.content.map((part) => part.type === "text" ? part.text : "")
  ).join("\n");
}

async function fixture(namespace: string, databaseSchema: string) {
  const db = await createTestDatabase({ url: ":memory:" });
  const inputs: LlmAdapterCallInput[] = [];
  const agent = defineAgent({
    id: "assistant-agent",
    name: "Assistant",
    role: "assistant",
    models: { generate: [{ connection: "offline", model: "test" }] },
  });
  const support = definePlugin({
    id: `test.message-input.${namespace}`,
    version: "1.0.0",
    resources: {
      agents: { assistant: agent },
      llmConnections: { offline: { adapter: "offline" } },
    },
    adapters: { llm: { offline: adapter(inputs) } },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace,
    databaseSchema,
    plugins: [corePlugin, support],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  return {
    application,
    inputs,
    domain: createTestDomainContext(application, namespace),
    collections(targetNamespace = namespace) {
      return application.collections.withScope({ namespace: targetNamespace });
    },
    async close() {
      await application.shutdown();
      await db.close();
    },
  };
}

type ActionCall = Readonly<{
  input: Record<string, unknown>;
  operationKey: string;
}>;

function fakeProcessorInvocation(
  conflict:
    | "participant-create"
    | "thread-update"
    | "schema"
    | "cancel"
    | "participant-type",
) {
  const calls: ActionCall[] = [];
  const participants = new Map<string, Record<string, unknown>>();
  let thread: Record<string, unknown> | null = null;
  let injectedConflict = false;
  let senderWasMissingOnRetry = false;
  const context = {
    namespace: "processor-retry-test",
    resources: {
      agents: {
        assistant: {
          id: "assistant-agent",
          name: "Assistant",
        },
      },
    },
    collections: {
      thread: {
        get({ id }: { id: string }) {
          return Promise.resolve(thread?.id === id ? thread : null);
        },
        queries: {
          byExternalId() {
            return Promise.resolve([]);
          },
        },
      },
      participant: {
        get({ id }: { id: string }) {
          return Promise.resolve(participants.get(id) ?? null);
        },
        queries: {
          byExternalId({ externalId }: { externalId: string }) {
            return Promise.resolve(
              [...participants.values()].filter((item) =>
                item.externalId === externalId
              ),
            );
          },
        },
      },
      message: {
        get() {
          return Promise.resolve(null);
        },
      },
    },
    actions: {
      createThread(input: Record<string, unknown>) {
        thread = {
          id: input.id,
          ...(input.externalId ? { externalId: input.externalId } : {}),
          participantIds: [],
        };
        return Promise.resolve(thread);
      },
      createThreadMessage(
        input: Record<string, unknown>,
        options: { operationKey: string },
      ) {
        calls.push({ input, operationKey: options.operationKey });
        if (calls.length === 2) {
          const sender = input.sender as Record<string, unknown>;
          senderWasMissingOnRetry = !participants.has(String(sender.id));
        }
        if (calls.length === 1) {
          if (conflict === "participant-create") {
            const membership = input.membership as {
              participants: Record<string, unknown>[];
            };
            const agent = membership.participants.find((item) =>
              item.externalId === "assistant-agent"
            )!;
            participants.set(String(agent.id), {
              ...agent,
              participantType: "agent",
            });
            injectedConflict = true;
            return Promise.reject(
              new Error(
                `Collection 'participant' '${agent.id}' was created while its mutation was prepared.`,
              ),
            );
          }
          if (conflict === "participant-type") {
            const membership = input.membership as {
              participants: Record<string, unknown>[];
            };
            const agent = membership.participants.find((item) =>
              item.externalId === "assistant-agent"
            )!;
            participants.set(String(agent.id), {
              ...agent,
              participantType: "human",
            });
            injectedConflict = true;
            return Promise.reject(
              new Error(
                `Collection 'participant' '${agent.id}' was created while its mutation was prepared.`,
              ),
            );
          }
          if (conflict === "thread-update") {
            injectedConflict = true;
            return Promise.reject(
              new Error(
                `Collection 'thread' '${input.threadId}' changed while its mutation was prepared.`,
              ),
            );
          }
          if (conflict === "cancel") {
            return Promise.reject(new DOMException("cancelled", "AbortError"));
          }
          return Promise.reject(
            new TypeError("message input failed schema validation"),
          );
        }
        return Promise.resolve({ id: input.id });
      },
    },
  };
  const envelope = message({
    thread: { externalId: "retry-thread" },
    participant: { externalId: "new-sender", participantType: "human" },
    recipientIds: ["assistant"],
    content: "hello",
  });
  const event = {
    durable: true,
    id: "retry-event",
    position: "1",
    schemaVersion: 1,
    type: CORE_MESSAGE_INPUT_EVENT,
    namespace: context.namespace,
    payload: envelope.payload,
    metadata: {},
    correlationId: "retry-correlation",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  return {
    calls,
    participants,
    get injectedConflict() {
      return injectedConflict;
    },
    get senderWasMissingOnRetry() {
      return senderWasMissingOnRetry;
    },
    async run() {
      await messageInputProcessor.handle(event as never, context as never);
    },
  };
}
Deno.test("Message input Processor owns its identity", () =>
  assertEquals(messageInputProcessor.id, "copilotz.core.message-input"));

Deno.test("Core Message bootstraps a thread, enrolls its Agent, and reuses history", async () => {
  const test = await fixture(
    "message-input-bootstrap",
    "message_input_bootstrap",
  );
  try {
    const first = await test.application.send(message({
      thread: { externalId: "hello" },
      participant: { externalId: "you", participantType: "human" },
      recipientIds: ["assistant"],
      content: "first question",
    }));
    await first.done;

    const threads = test.collections().thread;
    const threadRecords = await threads.queries.byExternalId({
      externalId: "hello",
    });
    assertEquals(threadRecords.length, 1);
    const thread = threadRecords[0];
    const participants = test.collections().participant;
    const [sender, assistant] = await Promise.all([
      participants.queries.byExternalId({ externalId: "you" }),
      participants.queries.byExternalId({ externalId: "assistant-agent" }),
    ]);
    assertEquals(sender.length, 1);
    assertEquals(sender[0].participantType, "human");
    assertEquals(assistant.length, 1);
    assertEquals(assistant[0].participantType, "agent");
    assertEquals(assistant[0].agentId, "assistant-agent");
    assertEquals(assistant[0].name, "Assistant");
    assert((thread.participantIds as string[]).includes(sender[0].id));
    assert((thread.participantIds as string[]).includes(assistant[0].id));
    assertEquals(test.inputs.length, 1);

    const second = await test.application.send(message({
      thread: { externalId: "hello" },
      participant: { externalId: "you", participantType: "human" },
      recipientIds: ["assistant-agent"],
      content: "follow-up question",
    }));
    await second.done;
    assertEquals(
      (await threads.queries.byExternalId({ externalId: "hello" })).length,
      1,
    );
    assertEquals(
      (await participants.queries.byExternalId({
        externalId: "assistant-agent",
      })).length,
      1,
    );
    assertEquals(test.inputs.length, 2);
    assertStringIncludes(prompt(test.inputs[1]), "first question");
    assertStringIncludes(prompt(test.inputs[1]), "follow-up question");
  } finally {
    await test.close();
  }
});

Deno.test("unknown Agent selection leaves a bootstrap Thread and participants untouched", async () => {
  const test = await fixture("message-input-unknown", "message_input_unknown");
  try {
    const send = await test.application.send(message({
      thread: { externalId: "should-not-exist" },
      participant: {
        externalId: "sender-before-validation",
        participantType: "human",
      },
      recipientIds: ["not-registered"],
      content: "hello",
    }));
    await assertRejects(() => send.done, Error, "was not found");
    assertEquals(
      (await test.collections().thread.queries.byExternalId({
        externalId: "should-not-exist",
      })).length,
      0,
    );
    assertEquals(
      (await test.collections().participant.queries.byExternalId({
        externalId: "sender-before-validation",
      })).length,
      0,
    );
    assertEquals(test.inputs.length, 0);
  } finally {
    await test.close();
  }
});

Deno.test("an object reference stays strict when it reuses an existing Thread", async () => {
  const test = await fixture(
    "message-input-existing-object-unknown",
    "message_input_existing_object_unknown",
  );
  try {
    const first = await test.application.send(message({
      thread: { externalId: "existing-object-thread" },
      participant: { externalId: "existing-user", participantType: "human" },
      recipientIds: [],
      content: "existing message",
    }));
    await first.done;
    const [thread] = await test.collections().thread.queries.byExternalId({
      externalId: "existing-object-thread",
    });

    const invalid = await test.application.send(message({
      thread: { externalId: "existing-object-thread" },
      participant: {
        externalId: "must-not-be-created",
        participantType: "human",
      },
      recipientIds: ["not-registered"],
      content: "invalid follow-up",
    }));
    await assertRejects(() => invalid.done, Error, "was not found");

    assertEquals(
      (await test.collections().thread.queries.byExternalId({
        externalId: "existing-object-thread",
      })).length,
      1,
    );
    assertEquals(
      (await test.collections().participant.queries.byExternalId({
        externalId: "must-not-be-created",
      })).length,
      0,
    );
    assertEquals(
      (await test.collections().message.queries.history({
        threadId: thread.id,
        limit: 10,
      })).length,
      1,
    );
  } finally {
    await test.close();
  }
});

Deno.test("a string Thread reference still requires an existing Thread", async () => {
  const test = await fixture(
    "message-input-missing-string",
    "message_input_missing_string",
  );
  try {
    const send = await test.application.send(message({
      thread: "missing-thread",
      participant: { externalId: "sender", participantType: "human" },
      recipientIds: ["assistant"],
      content: "hello",
    }));
    await assertRejects(() => send.done, Error, "was not found");
    assertEquals(
      (await test.collections().thread.queries.byExternalId({
        externalId: "missing-thread",
      })).length,
      0,
    );
    assertEquals(test.inputs.length, 0);
  } finally {
    await test.close();
  }
});

Deno.test("existing participant ID and external ID recipients join new Threads with their type", async () => {
  const test = await fixture(
    "message-input-existing-recipient",
    "message_input_existing_recipient",
  );
  try {
    await test.domain.actions.createThread({
      id: "participant-seed-thread",
      participants: [{
        id: "shared-tool-id",
        externalId: "shared-tool-external",
        participantType: "tool",
        name: "Shared tool",
      }],
    });
    const tool = await test.collections().participant.get({
      id: "shared-tool-id",
    });
    assertEquals(tool?.participantType, "tool");

    const byExternalId = await test.application.send(message({
      thread: { externalId: "recipient-by-external-id" },
      participant: { externalId: "external-user", participantType: "human" },
      recipientIds: ["shared-tool-external"],
      content: "external recipient",
    }));
    const byId = await test.application.send(message({
      thread: { externalId: "recipient-by-id" },
      participant: { externalId: "id-user", participantType: "human" },
      recipientIds: ["shared-tool-id"],
      content: "ID recipient",
    }));
    await Promise.all([byExternalId.done, byId.done]);

    for (const externalId of ["recipient-by-external-id", "recipient-by-id"]) {
      const [thread] = await test.collections().thread.queries.byExternalId({
        externalId,
      });
      assert((thread.participantIds as string[]).includes("shared-tool-id"));
      const history = await test.collections().message.queries.history({
        threadId: thread.id,
        limit: 10,
      });
      assert(history.some((item) =>
        Array.isArray(item.recipientIds) &&
        item.recipientIds.includes("shared-tool-id")
      ));
    }
    assertEquals(
      (await test.collections().participant.get({ id: "shared-tool-id" }))
        ?.participantType,
      "tool",
    );
    assertEquals(test.inputs.length, 0);
  } finally {
    await test.close();
  }
});

Deno.test("identical external Thread IDs are isolated by tenant namespace", async () => {
  const test = await fixture("message-input-tenant-a", "message_input_tenants");
  try {
    const tenantA = await test.application.send(message({
      thread: { externalId: "same-external-id" },
      participant: { externalId: "same-sender", participantType: "human" },
      recipientIds: ["assistant"],
      content: "tenant A",
    }));
    const tenantB = await test.application.send({
      ...message({
        thread: { externalId: "same-external-id" },
        participant: { externalId: "same-sender", participantType: "human" },
        recipientIds: ["assistant"],
        content: "tenant B",
      }),
      namespace: "message-input-tenant-b",
    });
    await Promise.all([tenantA.done, tenantB.done]);

    const a = await test.collections("message-input-tenant-a").thread
      .queries.byExternalId({ externalId: "same-external-id" });
    const b = await test.collections("message-input-tenant-b").thread
      .queries.byExternalId({ externalId: "same-external-id" });
    assertEquals(a.length, 1);
    assertEquals(b.length, 1);
    assert(a[0].id !== b[0].id);
    const aAgent = await test.collections("message-input-tenant-a").participant
      .queries.byExternalId({ externalId: "assistant-agent" });
    const bAgent = await test.collections("message-input-tenant-b").participant
      .queries.byExternalId({ externalId: "assistant-agent" });
    const aSender = await test.collections("message-input-tenant-a").participant
      .queries.byExternalId({ externalId: "same-sender" });
    const bSender = await test.collections("message-input-tenant-b").participant
      .queries.byExternalId({ externalId: "same-sender" });
    assertEquals(aAgent.length, 1);
    assertEquals(bAgent.length, 1);
    assert(aAgent[0].id !== bAgent[0].id);
    assertEquals(aSender.length, 1);
    assertEquals(bSender.length, 1);
    assert(aSender[0].id !== bSender[0].id);
  } finally {
    await test.close();
  }
});

Deno.test("concurrent bootstrap and event replay reuse one Thread and canonical Agent", async () => {
  const test = await fixture(
    "message-input-concurrent",
    "message_input_concurrent",
  );
  try {
    const firstInput = message({
      thread: { externalId: "concurrent" },
      participant: { externalId: "one", participantType: "human" },
      recipientIds: ["assistant"],
      content: "first concurrent question",
      deduplicationId: "first-concurrent-message",
      correlationId: "first-concurrent-correlation",
    });
    const secondInput = message({
      thread: { externalId: "concurrent" },
      participant: { externalId: "two", participantType: "human" },
      recipientIds: ["assistant-agent"],
      content: "second concurrent question",
      deduplicationId: "second-concurrent-message",
      correlationId: "second-concurrent-correlation",
    });
    const [first, second] = await Promise.all([
      test.application.send(firstInput),
      test.application.send(secondInput),
    ]);
    await Promise.all([first.done, second.done]);
    const replay = await test.application.send(firstInput);
    await replay.done;

    const threads = await test.collections().thread.queries.byExternalId({
      externalId: "concurrent",
    });
    const agents = await test.collections().participant.queries.byExternalId({
      externalId: "assistant-agent",
    });
    assertEquals(threads.length, 1);
    assertEquals(agents.length, 1);
    assertEquals(test.inputs.length, 2);
    const history = await test.collections().message.queries.history({
      threadId: threads[0].id,
      limit: 100,
    });
    assertEquals(history.length, 4);
    assertEquals(new Set(history.map((item) => item.id)).size, 4);
    const prompts = test.inputs.map(prompt).join("\n");
    assertStringIncludes(prompts, "first concurrent question");
    assertStringIncludes(prompts, "second concurrent question");
  } finally {
    await test.close();
  }
});

Deno.test("concurrent first sends to separate Threads share one canonical Agent", async () => {
  const test = await fixture(
    "message-input-concurrent-rooms",
    "message_input_concurrent_rooms",
  );
  try {
    const [roomA, roomB] = await Promise.all([
      test.application.send(message({
        thread: { externalId: "new-room-a" },
        participant: { externalId: "room-a-user", participantType: "human" },
        recipientIds: ["assistant"],
        content: "room a first question",
      })),
      test.application.send(message({
        thread: { externalId: "new-room-b" },
        participant: { externalId: "room-b-user", participantType: "human" },
        recipientIds: ["assistant-agent"],
        content: "room b first question",
      })),
    ]);
    await Promise.all([roomA.done, roomB.done]);

    const agent = await test.collections().participant.queries.byExternalId({
      externalId: "assistant-agent",
    });
    assertEquals(agent.length, 1);
    assertEquals(agent[0].participantType, "agent");
    assertEquals(test.inputs.length, 2);
    const prompts = test.inputs.map(prompt).join("\n");
    assertStringIncludes(prompts, "room a first question");
    assertStringIncludes(prompts, "room b first question");
    for (const externalId of ["new-room-a", "new-room-b"]) {
      const [thread] = await test.collections().thread.queries.byExternalId({
        externalId,
      });
      assert((thread.participantIds as string[]).includes(agent[0].id));
      const history = await test.collections().message.queries.history({
        threadId: thread.id,
        limit: 10,
      });
      assertEquals(history.length, 2);
    }
  } finally {
    await test.close();
  }
});

Deno.test("an explicit object Thread ID remains the created record ID", async () => {
  const test = await fixture(
    "message-input-explicit-id",
    "message_input_explicit_id",
  );
  try {
    const first = await test.application.send(message({
      thread: { id: "requested-thread-id" },
      participant: { externalId: "id-user", participantType: "human" },
      recipientIds: [],
      content: "first",
    }));
    await first.done;
    const thread = await test.collections().thread.get({
      id: "requested-thread-id",
    });
    assertEquals(thread?.id, "requested-thread-id");

    const second = await test.application.send(message({
      thread: { id: "requested-thread-id" },
      participant: { externalId: "id-user", participantType: "human" },
      recipientIds: [],
      content: "second",
    }));
    await second.done;
    assertEquals(
      (await test.collections().thread.get({ id: "requested-thread-id" }))?.id,
      "requested-thread-id",
    );
    assertEquals(test.inputs.length, 0);
  } finally {
    await test.close();
  }
});

Deno.test("a confirmed concurrent Agent create conflict retries once with fresh Action identity", async () => {
  const test = fakeProcessorInvocation("participant-create");
  await test.run();
  assert(test.injectedConflict);
  assertEquals(test.calls.length, 2);
  assertEquals(test.calls[0].operationKey, "core-message-input");
  assertEquals(
    test.calls[1].operationKey,
    "core-message-input-retry:retry-event",
  );
  assert(test.senderWasMissingOnRetry);
  const [agent] = [...test.participants.values()];
  assertEquals(agent?.participantType, "agent");
  assertEquals(agent?.externalId, "assistant-agent");
});

Deno.test("a confirmed Thread membership conflict retries the message once", async () => {
  const test = fakeProcessorInvocation("thread-update");
  await test.run();
  assert(test.injectedConflict);
  assertEquals(test.calls.length, 2);
  assertEquals(
    test.calls[1].operationKey,
    "core-message-input-retry:retry-event",
  );
});

Deno.test("a participant-create conflict with mismatched type is never retried", async () => {
  const test = fakeProcessorInvocation("participant-type");
  await assertRejects(() => test.run(), Error, "was created while");
  assert(test.injectedConflict);
  assertEquals(test.calls.length, 1);
  const [agent] = [...test.participants.values()];
  assertEquals(agent?.participantType, "human");
});

Deno.test("schema and cancellation failures are never retried", async () => {
  for (const kind of ["schema", "cancel"] as const) {
    const test = fakeProcessorInvocation(kind);
    await assertRejects(() => test.run());
    assertEquals(test.calls.length, 1);
  }
});
