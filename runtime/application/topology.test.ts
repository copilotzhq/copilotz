import { assert, assertEquals, assertExists } from "@std/assert";
import { createCopilotzGateway, createCopilotzWorker } from "./index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { listen } from "../adapters/deno/listen.ts";
import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";
import { defineProcessor } from "../plugins/processor.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import type { Agent } from "../resources/index.ts";
import {
  type AttachmentOutput,
  type AttachmentStreamOutput,
  defineRealtimeProviderResource,
} from "../attachments/index.ts";

const namespace = "copilotz-topology-test";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cascadingPlugin(): CopilotzPlugin {
  const first = defineProcessor<CopilotzProcessorContext>({
    id: "topology.first",
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => event.routing?.senderId === "topology-user",
    async handle(event, context) {
      assert(event.durable);
      assertExists(event.threadId);
      const content = await context.content.prepare("first worker reply", {
        operationKey: "first-content",
      });
      await context.conversation.createMessage({
        id: "topology-first-reply",
        threadId: event.threadId,
        sender: {
          id: "topology-agent",
          externalId: "topology-agent",
          participantType: "agent",
          agentId: "topology-agent",
        },
        recipientIds: ["topology-user"],
        content,
      }, { operationKey: "first-message" });
      await context.events.emit({
        type: "text.delta",
        threadId: event.threadId,
        payload: { text: "first worker reply" },
      });
    },
  });
  const second = defineProcessor<CopilotzProcessorContext>({
    id: "topology.second",
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => event.routing?.senderId === "topology-agent",
    async handle(event, context) {
      assert(event.durable);
      assertExists(event.threadId);
      const content = await context.content.prepare("cascaded worker reply", {
        operationKey: "second-content",
      });
      await context.conversation.createMessage({
        id: "topology-second-reply",
        threadId: event.threadId,
        sender: {
          id: "topology-second-agent",
          externalId: "topology-second-agent",
          participantType: "agent",
          agentId: "topology-second-agent",
        },
        recipientIds: ["topology-user"],
        content,
      }, { operationKey: "second-message" });
    },
  });
  return definePlugin({
    manifest: {
      id: "@copilotz/topology-test",
      version: "1.0.0",
      provides: { processors: [first.id, second.id] },
    },
    resources: { processors: [first, second] },
  });
}

function realtimePlugin(): CopilotzPlugin {
  const agent: Agent = Object.freeze({
    id: "topology-realtime-agent",
    name: "Topology realtime agent",
    role: "Echo realtime input",
    runtimes: {
      realtime: {
        type: "realtime" as const,
        provider: "topology.realtime.echo",
      },
    },
  });
  const provider = defineRealtimeProviderResource({
    id: "topology.realtime.echo",
    type: "realtime",
    open(input) {
      return {
        mediaType: input.mediaType,
        metadata: { provider: "topology.realtime.echo" },
        output: input.input.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              controller.enqueue(
                encoder.encode(decoder.decode(chunk).toUpperCase()),
              );
            },
          }),
        ),
      };
    },
  });
  return definePlugin({
    manifest: {
      id: "@copilotz/topology-realtime-test",
      version: "1.0.0",
      provides: {
        agents: [agent.id],
        providers: [provider.id],
      },
    },
    resources: {
      agents: [agent],
      providers: [provider],
    },
  });
}

function byteStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

function isStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  return output.type === "stream.output" && "payload" in output;
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
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
    core: false,
    database,
    plugins: [plugin],
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
    core: false,
    database,
    plugins: [plugin],
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
    await gateway.conversation.createThread({
      namespace,
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
    const run = await gateway.run({
      thread: "topology-thread",
      participant: "topology-user",
      recipientIds: ["topology-agent"],
      content: "start",
    });
    const events = collect(run.events);
    await run.done;

    const observed = await events;
    assertEquals(
      observed.filter((event) => event.type === "message.created").length,
      3,
    );
    assertEquals(
      observed.filter((event) => event.type === "text.delta").length,
      1,
    );
    assertEquals(
      (await gateway.conversation.listMessages(namespace, "topology-thread"))
        .length,
      3,
    );
    assertEquals(worker.snapshot().transport, "in-process");
    assertEquals(accepted, 2);
    assertEquals(ready, 1);
    assertEquals(started, 2);
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

Deno.test({
  name: "Gateway and Worker preserve Copilotz semantics over WebSocket",
  async fn() {
    const database = await createTestDatabase({ url: ":memory:" });
    const plugin = cascadingPlugin();
    const realtime = realtimePlugin();
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
      core: false,
      database,
      plugins: [plugin, realtime],
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
      core: false,
      database,
      plugins: [plugin, realtime],
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
      assertEquals(
        (await fetch(new URL("v3/agents", listener.url))).status,
        200,
      );
      await gateway.conversation.createThread({
        namespace,
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
      const run = await gateway.run({
        thread: "topology-thread",
        participant: "topology-user",
        recipientIds: ["topology-agent"],
        content: "start",
      });
      const events = collect(run.events);
      await run.done;
      const observed = await events;
      assertEquals(
        observed.filter((event) => event.type === "message.created").length,
        3,
      );
      assertEquals(
        observed.filter((event) => event.type === "text.delta").length,
        1,
      );
      assertEquals(worker.snapshot().transport, "websocket");

      await gateway.conversation.createThread({
        namespace,
        id: "topology-realtime-thread",
        participants: [{
          id: "topology-realtime-user",
          externalId: "topology-realtime-user",
          participantType: "human",
        }, {
          id: "topology-realtime-participant",
          externalId: "topology-realtime-agent",
          participantType: "agent",
          agentId: "topology-realtime-agent",
        }],
      });
      const attachment = await gateway.connect({
        thread: "topology-realtime-thread",
        participant: "topology-realtime-user",
        recipientIds: ["topology-realtime-agent"],
      });
      const reader = attachment.outputs.getReader();
      const stream = await attachment.send({
        type: "audio.input",
        mediaType: "audio/pcm;rate=24000",
        payload: byteStream("realtime over websocket"),
        correlationId: "topology-realtime-correlation",
      });
      const semanticTypes: string[] = [];
      let output: AttachmentStreamOutput | undefined;
      while (!output) {
        const next = await reader.read();
        assertEquals(next.done, false);
        if (isStreamOutput(next.value!)) output = next.value;
        else semanticTypes.push(next.value!.type);
      }
      assertEquals(output.participant.externalId, "topology-realtime-agent");
      assertEquals(output.correlationId, "topology-realtime-correlation");
      assertEquals(await readText(output.payload), "REALTIME OVER WEBSOCKET");
      await stream.done;
      while (!semanticTypes.includes("stream.closed")) {
        const next = await reader.read();
        assertEquals(next.done, false);
        if (!isStreamOutput(next.value!)) semanticTypes.push(next.value!.type);
      }
      assert(semanticTypes.includes("stream.opened"));
      const persisted = await gateway.events.list({
        namespace,
        threadId: "topology-realtime-thread",
        correlationId: "topology-realtime-correlation",
      });
      assertEquals(persisted.map((event) => event.type), [
        "stream.opened",
        "stream.closed",
      ]);
      await reader.cancel();
      await attachment.close();
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
