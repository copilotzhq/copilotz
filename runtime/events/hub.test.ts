import { assertEquals } from "@std/assert";

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
  schemaVersion: 1,
  type: "message.created",
  namespace: "tenant-a",
  threadId: "thread-a",
  subject: { type: "message", id: "message-a" },
  payload: { messageId: "message-a" },
  routing: {},
  visibility: { kind: "public" as const },
  metadata: { nested: { phase: "answer", retained: true } },
  correlationId: "correlation-a",
  createdAt: "2026-08-06T00:00:00.000Z",
});

const ephemeral: EphemeralEvent = Object.freeze({
  durable: false,
  type: "text.delta",
  namespace: "tenant-a",
  threadId: "thread-a",
  payload: { text: "hello" },
  routing: {},
  visibility: { kind: "public" as const },
  metadata: {},
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
    threadId: "thread-a",
    types: ["text.delta"],
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
    timeoutMs: 1_000,
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
