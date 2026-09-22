import { assertEquals, assertExists } from "@std/assert";
import { createSqlSession } from "../events/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
  type ProcessorEvent,
} from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "./index.ts";

function textRef() {
  return {
    assetId: "event-content-text",
    kind: "text" as const,
    role: "body",
    mediaType: "text/plain",
    name: "message.txt",
    metadata: { source: "event" },
    value: "untrusted text",
    extra: "not durable",
  };
}

function canonicalTextRef() {
  return {
    assetId: "event-content-text",
    kind: "text" as const,
    role: "body",
    mediaType: "text/plain",
    name: "message.txt",
    metadata: { source: "event" },
  };
}

function assertHydrated(event: ProcessorEvent | null | undefined): void {
  assertExists(event);
  assertEquals(event.data, {
    nested: [
      {
        assetId: "event-content-text",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        name: "message.txt",
        metadata: { source: "event" },
        value: "resolved text",
      },
    ],
  });
}

Deno.test("engine hydrates durable, live, output, and replay Event content", async () => {
  let durable: ProcessorEvent | undefined;
  let live: ProcessorEvent | undefined;
  const durableProcessor = defineProcessor({
    id: "event-content.durable",
    on: [{ eventType: "event.content.durable" }],
    handle(event) {
      durable = event;
    },
  });
  const liveProcessor = defineProcessor({
    id: "event-content.live",
    on: [{ eventType: "event.content.live" }],
    handle(event) {
      live = event;
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.event-content",
      version: "1.0.0",
      processors: { durable: durableProcessor },
    })],
  });
  const outputs: ProcessorEvent[] = [];
  const db = await createTestDatabase({ url: ":memory:" });
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    transientProcessors: [liveProcessor],
    defaultDatabaseSchema: "copilotz_event_content",
    async publish(output) {
      if ("data" in output) outputs.push(output);
    },
  });
  try {
    await engine.content.assets.publish({
      id: "event-content-text",
      namespace: "tenant-a",
      mediaType: "text/plain",
      body: new TextEncoder().encode("resolved text"),
    });

    const committed = await engine.events.append({
      type: "event.content.durable",
      namespace: "tenant-a",
      payload: { nested: [textRef()] },
      correlationId: "durable-content",
    });
    await Promise.all(committed.dispatch.handles.map((handle) => handle.done));

    const raw = await engine.events.get("tenant-a", committed.event.id);
    assertEquals(raw?.payload, { nested: [canonicalTextRef()] });
    assertHydrated(durable);
    assertHydrated(
      outputs.find((event) => event.type === "event.content.durable"),
    );
    assertHydrated(
      await engine.events.resolve("tenant-a", committed.event.id),
    );

    const emitted = await engine.events.emit({
      type: "event.content.live",
      namespace: "tenant-a",
      payload: { nested: [textRef()] },
      correlationId: "live-content",
    });
    assertEquals(emitted.payload, { nested: [textRef()] });
    assertHydrated(live);
    assertHydrated(
      outputs.find((event) => event.type === "event.content.live"),
    );
  } finally {
    await engine.shutdown();
    await db.close();
  }
});
