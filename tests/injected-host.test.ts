import { assertEquals } from "@std/assert";
import {
  createWorkerHost,
  type WorkerHostDispatchInput,
  type WorkerHostWorkHandle,
} from "@oxian/oxian-js/host";
import { Ominipg } from "omnipg";
import { resolveAutoProviders } from "omnipg/auto";
import {
  COPILOTZ_DELIVERY_WORKLOAD,
  createCopilotz,
  defineProcessor,
  type RealtimeProviderResource,
  type Tool,
} from "../index.ts";
import { createCopilotzWorkerRuntime } from "../execution/worker-runtime.ts";

Deno.test("an injected Oxian host recovers committed work and remains app-owned", async () => {
  const database = await Ominipg.connect({
    url: ":memory:",
    ...resolveAutoProviders({ url: ":memory:" }),
  });
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  let handled = 0;
  const processor = defineProcessor({
    id: "message.router",
    on: ["message.created"],
    delivery: "durable",
    handle: () => {
      handled++;
    },
  });
  const runtime = await createCopilotzWorkerRuntime({
    database: { instance: database },
    processors: [processor],
  });
  const worker = host.attachInProcessWorker({
    workerId: "shared-copilotz-worker",
    workloads: {
      ...runtime.workloads,
      "test.ping": () => ({
        metadata: { owner: "application" },
        body: new TextEncoder().encode("pong"),
      }),
    },
    capacity: 8,
  });
  let failDispatch = true;
  const dispatcher = {
    dispatch(input: WorkerHostDispatchInput): Promise<WorkerHostWorkHandle> {
      if (failDispatch && input.workload === COPILOTZ_DELIVERY_WORKLOAD) {
        return Promise.reject(new Error("simulated crash after commit"));
      }
      return host.dispatch(input);
    },
  };
  const copilotz = await createCopilotz({
    database: { instance: database },
    oxian: { dispatcher },
    maintenance: { periodic: false },
    processors: [processor],
  });

  try {
    const run = await copilotz.run({
      content: "recover me",
      sender: { externalId: "user", type: "user" },
    });
    assertEquals(handled, 0);
    assertEquals(
      (await copilotz.deliveries.list({ correlationId: run.correlationId }))
        .map((delivery) => delivery.status),
      ["pending"],
    );

    failDispatch = false;
    assertEquals((await copilotz.maintenance()).recovered, 1);
    await run.done;
    assertEquals(handled, 1);
    assertEquals(
      (await copilotz.deliveries.list({ correlationId: run.correlationId }))
        .map((delivery) => delivery.status),
      ["succeeded"],
    );

    await copilotz.shutdown();
    const ping = await host.dispatch({ workload: "test.ping" });
    assertEquals(await ping.metadata, { owner: "application" });
    assertEquals(await new Response(ping.output).text(), "pong");
    assertEquals((await ping.completed).status, "completed");
    assertEquals(
      (await database.query<{ value: number }>("SELECT 1 AS value"))
        .rows[0].value,
      1,
    );
  } finally {
    await copilotz.shutdown();
    await runtime.close();
    await worker.shutdown("test_complete");
    await host.shutdown("test_complete");
    await database.close();
  }
});

Deno.test("an injected stream worker wakes durable tool delivery immediately", async () => {
  const database = await Ominipg.connect({
    url: ":memory:",
    ...resolveAutoProviders({ url: ":memory:" }),
  });
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  let observedToolResult = false;
  const provider: RealtimeProviderResource = {
    resourceType: "providers",
    kind: "realtime",
    id: "remote.realtime",
    async *run(input) {
      for await (const _chunk of input.payload) {
        // Preserve stream backpressure before requesting work.
      }
      yield {
        kind: "message",
        input: {
          content: "",
          sender: { id: "remote-agent", type: "agent" },
          toolCalls: [{
            id: "remote-tool-call",
            tool: { id: "remote-echo" },
            args: { source: "remote-stream" },
          }],
        },
      };
      for await (const event of input.events) {
        if (event.type !== "message.created") continue;
        const payload = event.payload as Record<string, unknown>;
        const message = (payload.record ?? payload) as Record<string, unknown>;
        if (
          message.senderType === "tool" &&
          message.content === '{"source":"remote-stream"}'
        ) {
          observedToolResult = true;
          break;
        }
      }
      yield {
        kind: "message",
        input: {
          content: "Remote realtime continued.",
          sender: { id: "remote-agent", type: "agent" },
        },
      };
    },
  };
  const tool: Tool = {
    id: "remote-echo",
    key: "remote-echo",
    name: "Remote echo",
    description: "Return the input from a remote stream worker.",
    execute: (args) => args,
  };
  const agent = {
    id: "remote-agent",
    name: "Remote agent",
    role: "Test injected realtime execution",
    allowedAgents: [] as string[],
    allowedTools: [tool.id],
    runtimes: {
      realtime: { type: "realtime" as const, provider: provider.id },
    },
  };
  const runtime = await createCopilotzWorkerRuntime({
    database: { instance: database },
    providers: [provider],
    tools: [tool],
    agents: [agent],
  });
  const worker = host.attachInProcessWorker({
    workerId: "remote-stream-worker",
    workloads: runtime.workloads,
    capacity: 8,
  });
  const copilotz = await createCopilotz({
    database: { instance: database },
    oxian: { dispatcher: host },
    maintenance: { periodic: false },
    providers: [provider],
    tools: [tool],
    agents: [agent],
  });

  try {
    const attachment = await copilotz.connect({
      thread: "remote-realtime-thread",
      participant: { externalId: "user", participantType: "human" },
    });
    const sent = await attachment.send({
      type: "audio.input",
      mediaType: "audio/pcm;rate=24000",
      target: agent.id,
      payload: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
    });
    await Promise.race([
      sent.done,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("remote realtime delivery did not wake")),
          5_000,
        )
      ),
    ]);
    const messages = (await copilotz.events.list({
      correlationId: sent.correlationId,
    })).filter((event) => event.type === "message.created").map((event) => {
      const payload = event.payload as Record<string, unknown>;
      return ((payload.record ?? payload) as Record<string, unknown>).content;
    });
    assertEquals(observedToolResult, true);
    assertEquals(messages, [
      "",
      '{"source":"remote-stream"}',
      "Remote realtime continued.",
    ]);
    await attachment.close();
  } finally {
    await copilotz.shutdown();
    await runtime.close();
    await worker.shutdown("test_complete");
    await host.shutdown("test_complete");
    await database.close();
  }
});
