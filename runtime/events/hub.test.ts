import { assert, assertEquals } from "@std/assert";
import type { CopilotzEvent, DurableEvent, EphemeralEvent } from "./types.ts";
import {
  createCopilotzEventHub,
  matchesCopilotzEvent,
  waitForCopilotzEvent,
} from "./hub.ts";
const durable: DurableEvent = Object.freeze({
  durable: true,
  id: "event-a",
  position: "1",
  seq: "1",
  schemaVersion: 1,
  type: "message.created",
  namespace: "tenant-a",
  subject: { type: "message", id: "message-a" },
  payload: { messageId: "message-a" },
  metadata: {
    core: { threadId: "thread-a" },
    nested: { phase: "answer", retained: true },
  },
  correlationId: "correlation-a",
  createdAt: "2026-08-06T00:00:00.000Z",
});
const ephemeral: EphemeralEvent = Object.freeze({
  durable: false,
  type: "text.delta",
  namespace: "tenant-a",
  payload: { text: "hello" },
  metadata: { core: { threadId: "thread-a" } },
  correlationId: "correlation-a",
  streamId: "stream-a",
  sequence: 1,
  createdAt: "2026-08-06T00:00:00.000Z",
});
Deno.test("event hub filters durable replay and live ephemeral vocabulary", async () => {
  assertEquals(
    matchesCopilotzEvent(durable, {
      subject: { type: "message" },
      metadata: { nested: { phase: "answer" } },
    }),
    true,
  );
  assertEquals(
    matchesCopilotzEvent(durable, {
      metadata: { nested: { missing: true } },
    }),
    false,
  );
  const hub = createCopilotzEventHub();
  const reader = hub.subscribe({
    namespace: "tenant-a",
    types: ["text.delta"],
    metadata: {
      core: {
        threadId: "thread-a",
      },
    },
  }).getReader();
  await hub.publish(durable);
  await hub.publish(ephemeral);
  assertEquals((await reader.read()).value, ephemeral as CopilotzEvent);
  await reader.cancel();
  hub.close();
  assertEquals((await hub.subscribe().getReader().read()).done, true);
});
Deno.test("event waits combine durable replay with live subscription", async () => {
  const hub = createCopilotzEventHub();
  let loads = 0;
  const replayed = await waitForCopilotzEvent({
    hub,
    filter: {
      namespace: "tenant-a",
      types: ["message.created"],
      afterPosition: "0",
    },
    loadDurable: () => Promise.resolve(++loads > 1 ? [durable] : []),
    pollIntervalMs: 1,
    timeoutMs: 100,
  });
  assertEquals(replayed, durable);
  const live = waitForCopilotzEvent({
    hub,
    filter: { types: ["text.delta"] },
    pollIntervalMs: 100,
    timeoutMs: 1000,
  });
  await hub.publish(ephemeral);
  assertEquals(await live, ephemeral);
  hub.close();
});
Deno.test("A55 event hub is factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(new URL("hub.ts", import.meta.url));
  assertEquals(
    /\bclass\s+\w+|\bDeno\b|\bBun\b|\bprocess\b/.test(source),
    false,
  );
  assertEquals(/from\s+["']node:/.test(source), false);
});

Deno.test("event hub resets a full observer while a drained observer keeps ordered events", async () => {
  const hub = createCopilotzEventHub();
  const slow = hub.subscribe().getReader();
  const healthy = hub.subscribe().getReader();
  try {
    for (let index = 1; index <= 257; index++) {
      await hub.publish({
        ...durable,
        id: `event-${index}`,
        seq: String(index),
        position: String(index + 100),
      });
      const received = (await healthy.read()).value;
      assert(received?.durable);
      assertEquals(received.id, `event-${index}`);
    }
    let error: unknown;
    try {
      await slow.read();
    } catch (cause) {
      error = cause;
    }
    assertEquals(
      (error as { code?: string })?.code,
      "observation_reset_required",
    );
    assertEquals(
      matchesCopilotzEvent({ ...durable, seq: "3", position: "90" }, {
        afterSeq: "2",
      }),
      true,
    );
    assertEquals(
      matchesCopilotzEvent({ ...durable, seq: "3", position: "90" }, {
        afterSeq: "3",
      }),
      false,
    );
  } finally {
    await slow.cancel().catch(() => undefined);
    await healthy.cancel();
    hub.close();
  }
});

Deno.test("event hub loss reset permits replay attachment from the consumed sequence", async () => {
  const hub = createCopilotzEventHub();
  const old = hub.subscribe().getReader();
  hub.reset(
    Object.assign(new Error("lost final push"), {
      code: "observation_reset_required",
    }),
  );
  let failure: unknown;
  try {
    await old.read();
  } catch (error) {
    failure = error;
  }
  assertEquals(
    (failure as { code?: string }).code,
    "observation_reset_required",
  );
  const resumed = hub.subscribe({ afterSeq: "1" }).getReader();
  await hub.publish({ ...durable, seq: "1" });
  await hub.publish({ ...durable, seq: "2" });
  const event = (await resumed.read()).value;
  assert(event?.durable);
  assertEquals(event.seq, "2");
  await resumed.cancel();
  await old.cancel().catch(() => undefined);
  hub.close();
});
