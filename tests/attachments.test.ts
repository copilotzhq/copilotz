import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createCopilotz,
  defineProcessor,
  type EphemeralEvent,
} from "../index.ts";

Deno.test("run is a temporary attachment whose causal scope settles", async () => {
  let handled = 0;
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    processors: [defineProcessor({
      id: "message.router",
      on: ["message.created"],
      delivery: "durable",
      handle: () => {
        handled++;
      },
    })],
  });
  try {
    const handle = await copilotz.run({
      content: "hello",
      sender: { externalId: "user", type: "user" },
    });
    const observed = (async () => {
      const types: string[] = [];
      for await (const event of handle.events) types.push(event.type);
      return types;
    })();
    await handle.done;
    assertEquals(handled, 1);
    assertEquals(await observed, ["message.created"]);
    assertEquals(
      (await copilotz.events.list({ correlationId: handle.correlationId }))
        .map((event) => event.type),
      ["message.created"],
    );
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("live processors receive ephemeral events without delivery rows", async () => {
  let liveCount = 0;
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    processors: [
      defineProcessor({
        id: "test.emit",
        on: ["control.emit"],
        delivery: "durable",
        handle: (event, context) => {
          const emitted: EphemeralEvent = {
            durable: false,
            type: "text.delta",
            namespace: event.namespace,
            threadId: event.threadId,
            payload: { text: "delta" },
            routing: {},
            visibility: { kind: "public" },
            metadata: {},
            causationId: event.id,
            correlationId: event.correlationId,
            streamId: "test-stream",
            sequence: 0,
            createdAt: new Date().toISOString(),
          };
          context.emit(emitted);
        },
      }),
      defineProcessor<EphemeralEvent>({
        id: "test.live",
        on: ["text.delta"],
        delivery: "live",
        handle: () => {
          liveCount++;
        },
      }),
    ],
  });
  try {
    const attachment = await copilotz.connect({
      thread: "live-thread",
      participant: { externalId: "user", participantType: "human" },
    });
    const handle = await attachment.send({ type: "control.emit", payload: {} });
    await handle.done;
    for (let index = 0; index < 20 && liveCount === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(liveCount, 1);
    assertEquals(
      (await copilotz.deliveries.list({ correlationId: handle.correlationId }))
        .map((delivery) => delivery.consumerId),
      ["test.emit"],
    );
    await attachment.close();
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("discrete ingress resolves sender, target, and membership in one scope", async () => {
  let handled = 0;
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    agents: [{
      id: "target-agent",
      name: "Target agent",
      role: "Receive controls",
      allowedAgents: [],
      allowedTools: [],
    }],
    processors: [defineProcessor({
      id: "control.route",
      on: ["control.routed"],
      delivery: "durable",
      handle: () => {
        handled++;
      },
    })],
  });
  try {
    const attachment = await copilotz.connect({
      thread: "routed-control-thread",
      participant: { externalId: "viewer", participantType: "human" },
    });
    const handle = await attachment.send({
      type: "control.routed",
      payload: { action: "refresh" },
      sender: { externalId: "scheduler", type: "job" },
      target: "target-agent",
    });
    await handle.done;

    const events = await copilotz.events.list({
      correlationId: handle.correlationId,
    });
    const participants = events.filter((event) =>
      event.type === "participant.created"
    );
    const sender = participants.find((event) =>
      (event.payload as { externalId?: string }).externalId === "scheduler"
    );
    const target = participants.find((event) =>
      (event.payload as { agentId?: string }).agentId === "target-agent"
    );
    const routed = events.find((event) => event.type === "control.routed");
    assert(sender && target && routed);
    assert(sender.subject && target.subject);
    assertEquals(routed.routing.senderId, sender.subject.id);
    assertEquals(routed.routing.recipientIds, [target.subject.id]);
    assertEquals(
      events.filter((event) => event.type === "thread.participant_added")
        .length,
      2,
    );
    assertEquals(handled, 1);
    await attachment.close();
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("cancelling a run rejects done and settles its delivery", async () => {
  let started!: () => void;
  const executing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    processors: [defineProcessor({
      id: "message.router",
      on: ["message.created"],
      delivery: "durable",
      handle: (_event, context) => {
        started();
        return new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
    })],
  });
  try {
    const handle = await copilotz.run({
      content: "wait",
      sender: { externalId: "user", type: "user" },
    });
    await executing;
    await handle.cancel("user_cancelled");
    await assertRejects(() => handle.done, Error);
    assertEquals(
      (await copilotz.deliveries.list({ correlationId: handle.correlationId }))
        .map((delivery) => delivery.status),
      ["cancelled"],
    );
  } finally {
    await copilotz.shutdown();
  }
});
