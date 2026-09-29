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

async function fixture(
  options: Readonly<
    Pick<AgentResource, "instructions" | "dynamicResolve" | "history">
  > = {},
  now: () => Date = () => new Date(),
) {
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
          ...options,
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
    engine: { retryBaseMs: 0, random: () => 0, now },
  });
  const domain = createTestDomainContext(application, namespace, { now });
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

Deno.test("Agent history policy includes its inclusive cutoff and trigger", async () => {
  const triggerTime = Date.parse("2026-09-29T12:00:00.000Z");
  const clock = { value: triggerTime };
  const now = () => new Date(clock.value);
  const test = await fixture({ history: { maxAgeMs: 60_000 } }, now);
  try {
    clock.value = triggerTime - 60_001;
    await test.domain.actions.createThreadMessage({
      id: "outside-age-window",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      content: "OUTSIDE_AGE_WINDOW",
    });
    clock.value = triggerTime - 60_000;
    await test.domain.actions.createThreadMessage({
      id: "on-age-boundary",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      content: "ON_AGE_BOUNDARY",
    });
    clock.value = triggerTime;
    const sent = await test.application.send(message({
      thread: "thread",
      participant: "user",
      recipientIds: ["north"],
      content: "TRIGGER_INSIDE_AGE_WINDOW",
    }));
    await sent.done;
    const seen = prompt(test.inputs.at(-1)!);
    assert(!seen.includes("OUTSIDE_AGE_WINDOW"));
    assertStringIncludes(seen, "ON_AGE_BOUNDARY");
    assertStringIncludes(seen, "TRIGGER_INSIDE_AGE_WINDOW");
  } finally {
    await test.close();
  }
});

Deno.test("dynamic history policy replaces the Agent's static age limit", async () => {
  const triggerTime = Date.parse("2026-09-29T12:00:00.000Z");
  const clock = { value: triggerTime };
  const test = await fixture({
    history: { maxAgeMs: 24 * 60 * 60 * 1_000 },
    dynamicResolve: () => ({ history: { maxAgeMs: 1_000 } }),
  }, () => new Date(clock.value));
  try {
    clock.value = triggerTime - 1_001;
    await test.domain.actions.createThreadMessage({
      id: "static-only-history",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      content: "STATIC_ONLY_HISTORY",
    });
    clock.value = triggerTime - 1_000;
    await test.domain.actions.createThreadMessage({
      id: "dynamic-boundary-history",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      content: "DYNAMIC_BOUNDARY_HISTORY",
    });
    clock.value = triggerTime;
    const sent = await test.application.send(message({
      thread: "thread",
      participant: "user",
      recipientIds: ["north"],
      content: "DYNAMIC_POLICY_TRIGGER",
    }));
    await sent.done;
    const seen = prompt(test.inputs.at(-1)!);
    assert(!seen.includes("STATIC_ONLY_HISTORY"));
    assertStringIncludes(seen, "DYNAMIC_BOUNDARY_HISTORY");
    assertStringIncludes(seen, "DYNAMIC_POLICY_TRIGGER");
  } finally {
    await test.close();
  }
});

Deno.test("dynamic instructions retain the Agent's static history policy", async () => {
  const triggerTime = Date.parse("2026-09-29T12:00:00.000Z");
  const clock = { value: triggerTime - 60_001 };
  const test = await fixture({
    history: { maxAgeMs: 60_000 },
    dynamicResolve: () => ({ instructions: "Be concise." }),
  }, () => new Date(clock.value));
  try {
    await test.domain.actions.createThreadMessage({
      id: "older-than-static-policy",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      content: "OLDER_THAN_STATIC_POLICY",
    });
    clock.value = triggerTime;
    const sent = await test.application.send(message({
      thread: "thread",
      participant: "user",
      recipientIds: ["north"],
      content: "STATIC_POLICY_TRIGGER",
    }));
    await sent.done;
    const seen = prompt(test.inputs.at(-1)!);
    assert(!seen.includes("OLDER_THAN_STATIC_POLICY"));
    assertStringIncludes(seen, "STATIC_POLICY_TRIGGER");
  } finally {
    await test.close();
  }
});

Deno.test("history cutoff stays tied to the trigger timestamp on router retry", async () => {
  const triggerTime = Date.parse("2026-09-29T12:00:00.000Z");
  const clock = { value: triggerTime };
  let resolverCalls = 0;
  const test = await fixture({
    history: { maxAgeMs: 60_000 },
    dynamicResolve() {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        clock.value += 5 * 60_000;
        throw new Error("injected transient resolver failure");
      }
      return undefined;
    },
  }, () => new Date(clock.value));
  try {
    clock.value = triggerTime - 60_000;
    await test.domain.actions.createThreadMessage({
      id: "retry-boundary-history",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      content: "RETRY_BOUNDARY_HISTORY",
    });
    clock.value = triggerTime;
    const sent = await test.application.send(message({
      thread: "thread",
      participant: "user",
      recipientIds: ["north"],
      content: "RETRY_TRIGGER",
    }));
    await sent.done;
    assertEquals(resolverCalls, 2);
    assertEquals(test.inputs.length, 1);
    assertStringIncludes(prompt(test.inputs[0]), "RETRY_BOUNDARY_HISTORY");
    assertStringIncludes(prompt(test.inputs[0]), "RETRY_TRIGGER");
  } finally {
    await test.close();
  }
});

Deno.test("removing an Agent during preparation prevents the uncaptured model invocation", async () => {
  const entered = Promise.withResolvers<void>();
  const test = await fixture({
    dynamicResolve: async () => {
      entered.resolve();
      await Promise.resolve();
      return { instructions: "ready" };
    },
  });
  try {
    const sending = test.application.send(
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
    const sent = await sending;
    await sent.done;
    assertEquals(test.inputs.length, 0);
  } finally {
    await test.close();
  }
});
