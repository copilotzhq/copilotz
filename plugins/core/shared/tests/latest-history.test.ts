import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createCopilotzApplication } from "../../../../runtime/application/application.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { definePlugin } from "../../../../runtime/plugins/index.ts";
import {
  type AgentResource,
  corePlugin,
  defineAgent,
  defineContextResource,
  message,
} from "@copilotz/copilotz/core";
import {
  type BodyStorageOptions,
  type BodyStore,
  type ContentRef,
  createMemoryBodyStore,
} from "@copilotz/copilotz/content";
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
  runtimeOptions: Readonly<{
    assets?: BodyStorageOptions;
    promptContext?: Readonly<
      Record<string, ReturnType<typeof defineContextResource>>
    >;
  }> = {},
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
      promptContext: runtimeOptions.promptContext ?? {},
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
    ...(runtimeOptions.assets ? { assets: runtimeOptions.assets } : {}),
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
    db,
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
    // Seed a realistic graph from ordinary writes, then clone only the middle
    // history. The integration under test is paging and visibility on the final
    // route; mutation atomicity is covered by the Action/Collection suites.
    for (
      const [id, content] of [["old-0", "old-0"], ["old-1", "middle-history"]]
    ) {
      await test.domain.actions.createThreadMessage({
        id,
        threadId: "thread",
        sender: { id: "user", externalId: "user", participantType: "human" },
        // History only: it addresses no agent.
        recipientIds: [],
        content,
      });
    }
    await test.db.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO "latest_history".nodes
        (id,namespace,type,name,data,created_at,updated_at)
        SELECT 'old-' || i, namespace,type,name,data,
          created_at, updated_at
        FROM "latest_history".nodes CROSS JOIN generate_series(2,1003) i
        WHERE id='old-1' AND namespace=$1`,
        [namespace],
      );
      await transaction.query(
        `INSERT INTO "latest_history".edges
        (id,namespace,source_node_id,target_node_id,type,data,weight)
        SELECT 'history-seed:' || i || ':' || id, namespace,
          CASE WHEN source_node_id='old-1' THEN 'old-' || i ELSE source_node_id END,
          CASE WHEN target_node_id='old-1' THEN 'old-' || i ELSE target_node_id END,
          type,data,weight
        FROM "latest_history".edges CROSS JOIN generate_series(2,1003) i
        WHERE namespace=$1 AND (source_node_id='old-1' OR target_node_id='old-1')`,
        [namespace],
      );
    });
    await test.domain.actions.createThreadMessage({
      id: "old-1004",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      // History only: it addresses no agent.
      recipientIds: [],
      content: "old-1004",
    });
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
      // History only: it addresses no agent.
      recipientIds: [],
      content: "OUTSIDE_AGE_WINDOW",
    });
    clock.value = triggerTime - 60_000;
    await test.domain.actions.createThreadMessage({
      id: "on-age-boundary",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      // History only: it addresses no agent.
      recipientIds: [],
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
      // History only: it addresses no agent.
      recipientIds: [],
      content: "STATIC_ONLY_HISTORY",
    });
    clock.value = triggerTime - 1_000;
    await test.domain.actions.createThreadMessage({
      id: "dynamic-boundary-history",
      threadId: "thread",
      sender: { id: "user", externalId: "user", participantType: "human" },
      // History only: it addresses no agent.
      recipientIds: [],
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
      // History only: it addresses no agent.
      recipientIds: [],
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
      // History only: it addresses no agent.
      recipientIds: [],
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
  const release = Promise.withResolvers<void>();
  let armed = false;
  // Hold exactly the seeded context body's read. Every body read checks the
  // store's head first, including one whose bytes come from the repository's
  // prepared-body cache, so gating the first byte read of any body would
  // instead pause whichever read happened to miss that cache.
  let publishing = false;
  const contextBodies = new Set<string>();
  const backingStore = createMemoryBodyStore();
  const gatedStore: BodyStore = {
    ...backingStore,
    async put(input) {
      if (publishing) contextBodies.add(input.bodyId);
      return await backingStore.put(input);
    },
    async head(input) {
      if (armed && contextBodies.has(input.bodyId)) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return await backingStore.head(input);
    },
  };
  let promptRef: ContentRef | undefined;
  const promptContext = defineContextResource({
    id: "test.latest-history.seeded-context",
    type: "context",
    purposes: ["conversation"],
    contribute: () =>
      promptRef
        ? {
          id: "seeded-context",
          title: "Seeded context",
          role: "context",
          content: promptRef,
        }
        : null,
  });
  const test = await fixture({}, () => new Date(), {
    assets: { storage: { type: "custom", config: { store: gatedStore } } },
    promptContext: { seeded: promptContext },
  });
  let finishSend: (() => Promise<void>) | undefined;
  try {
    publishing = true;
    const asset = await test.domain.content.publish({
      mediaType: "text/plain",
      body: new TextEncoder().encode("context body held during preparation"),
    }, { operationKey: "seed-context" });
    publishing = false;
    assertEquals(contextBodies.size, 1, "the context body was stored");
    promptRef = {
      assetId: asset.id,
      kind: "text",
      role: "context",
      mediaType: asset.mediaType,
    };
    // The context body read occurs after the message router's metadata snapshot.
    armed = true;
    const sending = test.application.send(
      message({
        thread: "thread",
        participant: "user",
        recipientIds: ["north"],
        content: "start",
      }),
    );
    // Drain the in-flight turn during cleanup if an assertion or update fails.
    finishSend = async () => {
      try {
        const sent = await sending;
        await sent.done;
      } catch {
        // Preserve the original test failure while still releasing the fixture.
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out waiting for context-body read")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await test.domain.collections.thread.update({
      id: "thread",
      set: { participantIds: ["user", "other"] },
    });
    // Keep prompt-context resolution paused until membership removal commits.
    release.resolve();
    const sent = await sending;
    await sent.done;
    assertEquals(test.inputs.length, 0);
  } finally {
    // Unblock body resolution before waiting for the in-flight operation or closing.
    armed = false;
    release.resolve();
    await finishSend?.();
    await test.close();
  }
});
