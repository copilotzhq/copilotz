import { message as coreMessage } from "@copilotz/copilotz/core";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  createCopilotzGateway,
  createCopilotzPersistence,
  createCopilotzWorker,
} from "./index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { listen } from "../adapters/deno/listen.ts";
import {
  type AnyCopilotzPlugin,
  definePlugin,
  type ProcessorContext,
} from "../plugins/index.ts";
import { defineProcessor } from "../plugins/processor.ts";
import type { CopilotzDatabase } from "./persistence.ts";
import { isCopilotzPersistenceError } from "./persistence.ts";
import { coreCollectionsPlugin } from "../../plugins/core/plugin.ts";
import { createTestDomainContext } from "../testing/domain-context.ts";
import { projectMessages } from "../testing/projections.ts";

const namespace = "copilotz-topology-test";
function cascadingPlugin(): AnyCopilotzPlugin {
  const first = defineProcessor<ProcessorContext>({
    id: "topology.first",
    on: [{
      eventType: "message.created",
      routing: { senderId: "topology-user" },
    }],
    async handle(event, context) {
      assert(event.durable);
      assertExists(event.threadId);
      const stream = await context.streams.open({
        id: "topology-first-stream",
        mediaType: "text/plain",
        role: "assistant",
        metadata: {
          threadId: event.threadId,
          participantId: "topology-agent",
        },
        correlationId: event.correlationId,
      });
      await stream.append({
        bytes: new TextEncoder().encode("first worker reply"),
        appendId: "topology-first-chunk",
      });
      const persisted = await stream.close({
        assetId: "topology-first-reply-content",
      });
      await context.collections.message.create({
        id: "topology-first-reply",
        threadId: event.threadId,
        senderId: "topology-agent",
        recipientIds: ["topology-user"],
        content: persisted,
      }, {
        operationKey: "first-message",
        threadId: event.threadId,
        routing: {
          senderId: "topology-agent",
          recipientIds: ["topology-user"],
        },
      });
    },
  });
  const second = defineProcessor<ProcessorContext>({
    id: "topology.second",
    on: [{
      eventType: "message.created",
      routing: { senderId: "topology-agent" },
    }],
    async handle(event, context) {
      assert(event.durable);
      assertExists(event.threadId);
      const content = await context.content.prepare("cascaded worker reply", {
        operationKey: "second-content",
      });
      await context.collections.message.create({
        id: "topology-second-reply",
        threadId: event.threadId,
        senderId: "topology-second-agent",
        recipientIds: ["topology-user"],
        content,
      }, {
        operationKey: "second-message",
        threadId: event.threadId,
        routing: {
          senderId: "topology-second-agent",
          recipientIds: ["topology-user"],
        },
      });
    },
  });
  return definePlugin({
    id: "@copilotz/topology-test",
    version: "1.0.0",
    processors: { first, second },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

Deno.test("Gateway and Worker preserve live output and cascading durable work", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const transport = {
    type: "in-process",
    config: { topic: `copilotz.topology.${crypto.randomUUID()}` },
  } as const;
  const plugin = cascadingPlugin();
  const workerId = "copilotz-topology-worker";
  let accepted = 0;
  let ready = 0;
  let started = 0;
  const gateway = await createCopilotzGateway({
    namespace,
    database,
    plugins: [coreCollectionsPlugin, plugin],
    transports: [transport],
    target: { workerId },
    engine: { retryBaseMs: 0, random: () => 0 },
  }, {
    onWorkAccepted() {
      accepted += 1;
    },
  });
  const worker = await createCopilotzWorker({
    namespace,
    database,
    plugins: [coreCollectionsPlugin, plugin],
    id: workerId,
    transport,
    capacity: 1,
    engine: { retryBaseMs: 0, random: () => 0 },
  }, {
    onReady() {
      ready += 1;
    },
    onStart() {
      started += 1;
    },
  });

  try {
    await worker.ready;
    await createTestDomainContext(gateway, namespace).actions.createThread({
      id: "topology-thread",
      participants: [{
        id: "topology-user",
        externalId: "topology-user",
        participantType: "human",
      }, {
        id: "topology-agent",
        externalId: "topology-agent",
        participantType: "agent",
        agentId: "topology-agent",
      }, {
        id: "topology-second-agent",
        externalId: "topology-second-agent",
        participantType: "agent",
        agentId: "topology-second-agent",
      }],
    });
    const run = await gateway.send(coreMessage({
      thread: "topology-thread",
      participant: "topology-user",
      recipientIds: ["topology-agent"],
      content: "start",
    }));
    const events = collect(run.outputs);
    await run.done;

    const observed = await events;
    assertEquals(
      observed.filter((event) => event.type === "message.created").length,
      3,
    );
    assertEquals(
      observed.filter((event) => event.type === "stream.output").length,
      1,
    );
    assertEquals(
      (await projectMessages(gateway, namespace, "topology-thread"))
        .length,
      3,
    );
    assertEquals(worker.snapshot().transport, "in-process");
    assertEquals(accepted, 3);
    assertEquals(ready, 1);
    assertEquals(started, 3);
    assertEquals("execution" in gateway, false);
    assertEquals("engine" in gateway, false);
  } finally {
    await Promise.allSettled([
      gateway.shutdown("topology test complete"),
      worker.stop("topology test complete"),
    ]);
    await database.close();
  }
});

Deno.test("Gateway bounds persistence outages as retryable HTTP 503 responses", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  let generation = 0;
  let failNextQuery = false;
  const persistence = await createCopilotzPersistence({
    database: {
      connect({ signal }) {
        generation += 1;
        const selected = generation;
        if (selected > 1) {
          return new Promise<CopilotzDatabase>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }
        const query: CopilotzDatabase["query"] = async <
          TRow extends Record<string, unknown> = Record<string, unknown>,
        >(sql: string, params?: unknown[]) => {
          if (failNextQuery) {
            failNextQuery = false;
            throw Object.assign(new Error("connection reset by peer"), {
              code: "ECONNRESET",
            });
          }
          return await database.query<TRow>(sql, params);
        };
        return Object.freeze({
          query,
          transaction: database.transaction,
          close: () => Promise.resolve(),
        });
      },
    },
    databaseRecovery: { waitMs: 5, retryAfterSeconds: 3 },
  });
  const gateway = await createCopilotzGateway({
    namespace,
    plugins: [coreCollectionsPlugin],
    persistence,
  });
  try {
    assertEquals(gateway.config.databaseOwnership, "injected");
    failNextQuery = true;
    const failure = await assertRejects(() =>
      projectMessages(gateway, namespace, "missing-thread")
    );
    assert(isCopilotzPersistenceError(failure));
    assertEquals(failure.code, "persistence_indeterminate");

    const response = await gateway.fetch(
      new Request("https://example.test/v3/agents"),
    );
    assertEquals(response.status, 503);
    assertEquals(response.headers.get("retry-after"), "3");
    assertEquals((await response.json()).error.code, "persistence_unavailable");
    assertEquals(generation, 2);
  } finally {
    await gateway.shutdown();
    await persistence.close();
    await database.close();
  }
});

Deno.test({
  name: "Gateway and Worker preserve Copilotz semantics over WebSocket",
  async fn() {
    const database = await createTestDatabase({ url: ":memory:" });
    const plugin = cascadingPlugin();
    const workerId = "copilotz-websocket-topology-worker";
    const identity = {
      workerId,
      attemptId: crypto.randomUUID(),
      epoch: 1,
    } as const;
    const registrationCapability = crypto.randomUUID();
    const resumeCapability = crypto.randomUUID();
    const expiresAtMs = Date.now() + 60_000;
    const transport = {
      type: "websocket",
      config: { path: "/_copilotz/workers" },
    } as const;
    let resume:
      | Readonly<
        { capability: string; handshakeId: string; expiresAtMs: number }
      >
      | undefined;
    const gateway = await createCopilotzGateway({
      namespace,
      database,
      plugins: [coreCollectionsPlugin, plugin],
      transports: [transport],
      target: { workerId },
      admit(context) {
        if (
          context.identity.workerId !== workerId ||
          context.credential.capability !== registrationCapability
        ) {
          throw new Error("WebSocket Worker admission rejected.");
        }
        return {
          definition: {
            workerId,
            providerId: "copilotz-topology-test",
            workloads: [...context.workloads],
            capacity: context.capacity,
            providerConfig: {},
            labels: {},
          },
          sessionGeneration: 1,
          authenticatedWith: context.credential.kind,
          resume: {
            credential: { kind: "resume", capability: resumeCapability },
            expiresAtMs,
          },
          bootstrap: {},
        };
      },
      engine: { retryBaseMs: 0, random: () => 0 },
    });
    const listener = listen(gateway, { hostname: "127.0.0.1", port: 0 });
    const workerUrl = new URL(transport.config.path, listener.url);
    workerUrl.protocol = "ws:";
    const worker = await createCopilotzWorker({
      namespace,
      database,
      plugins: [coreCollectionsPlugin, plugin],
      id: workerId,
      transport: {
        type: "websocket",
        config: { url: workerUrl, allowInsecureLoopback: true },
      },
      activate: () => identity,
      register: () =>
        resume
          ? {
            credential: { kind: "resume", capability: resume.capability },
            expiresAtMs: resume.expiresAtMs,
            handshakeId: resume.handshakeId,
            resumeExpiresAtMs: resume.expiresAtMs,
          }
          : {
            credential: {
              kind: "registration",
              capability: registrationCapability,
            },
            expiresAtMs,
          },
      handshake: ({ rotation }) => {
        resume = {
          capability: rotation.credential.capability,
          handshakeId: rotation.handshakeId,
          expiresAtMs: rotation.resumeExpiresAtMs,
        };
      },
      reconnectDelay: false,
      capacity: 1,
      engine: { retryBaseMs: 0, random: () => 0 },
    });

    try {
      await worker.ready;
      await createTestDomainContext(gateway, namespace).actions.createThread({
        id: "topology-thread",
        participants: [{
          id: "topology-user",
          externalId: "topology-user",
          participantType: "human",
        }, {
          id: "topology-agent",
          externalId: "topology-agent",
          participantType: "agent",
          agentId: "topology-agent",
        }, {
          id: "topology-second-agent",
          externalId: "topology-second-agent",
          participantType: "agent",
          agentId: "topology-second-agent",
        }],
      });
      const run = await gateway.send(coreMessage({
        thread: "topology-thread",
        participant: "topology-user",
        recipientIds: ["topology-agent"],
        content: "start",
      }));
      const events = collect(run.outputs);
      await run.done;
      const observed = await events;
      assertEquals(
        observed.filter((event) => event.type === "message.created").length,
        3,
      );
      assertEquals(
        observed.filter((event) => event.type === "stream.output").length,
        1,
      );
      assertEquals(worker.snapshot().transport, "websocket");
    } finally {
      await Promise.allSettled([
        gateway.shutdown("WebSocket topology test complete"),
        worker.stop("WebSocket topology test complete"),
      ]);
      await listener.shutdown();
      await database.close();
    }
  },
});
