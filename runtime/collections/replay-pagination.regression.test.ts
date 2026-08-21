import { assertEquals } from "@std/assert";

import { digestContent } from "../content/digest.ts";
import type { DurableEvent, EventStore, SqlExecutor } from "../events/index.ts";
import { loadCollectionEventBodies } from "./replay.ts";

const EVENT_COUNT = 10_001;
const EVENT_BODY = JSON.stringify({
  operation: "create",
  record: {
    id: "shared-record",
    namespace: "tenant-replay",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  },
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort((
        [left],
        [right],
      ) => left.localeCompare(right)).map(([key, child]) =>
        `${JSON.stringify(key)}:${canonical(child)}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function durableEvent(position: number): DurableEvent {
  return Object.freeze({
    durable: true,
    id: `event-${position}`,
    position: String(position),
    schemaVersion: 3,
    type: "audit_record.created",
    namespace: "tenant-replay",
    payload: {
      dataRef: {
        eventBodyId: "shared-event-body",
        schemaVersion: 1,
        mediaType: "application/json",
      },
    },
    routing: {},
    visibility: { kind: "public" as const },
    metadata: {},
    correlationId: `correlation-${position}`,
    createdAt: "2026-08-19T00:00:00.000Z",
  });
}

Deno.test("collection replay reads every event page beyond 10,000 events", async () => {
  const events = Array.from(
    { length: EVENT_COUNT },
    (_, index) => durableEvent(index + 1),
  );
  const store = {
    tables: {
      nodes: "nodes",
      edges: "edges",
      events: "events",
      event_bodies: "event_bodies",
      event_deliveries: "event_deliveries",
    },
    listEvents(options: { afterPosition?: string; limit?: number }) {
      const after = Number(options.afterPosition ?? 0);
      const limit = options.limit ?? 1_000;
      return Promise.resolve(
        events.filter((event) => Number(event.position) > after).slice(
          0,
          limit,
        ),
      );
    },
  } as unknown as EventStore;
  const executor: SqlExecutor = {
    async query<TRow extends Record<string, unknown>>() {
      const body = JSON.parse(EVENT_BODY);
      return Promise.resolve({
        rows: [{
          namespace: "tenant-replay",
          event_body_id: "shared-event-body",
          schema_version: 1,
          body,
          digest: await digestContent(
            new TextEncoder().encode(canonical(body)),
          ),
          created_at: "2026-08-19T00:00:00.000Z",
        } as unknown as TRow],
      });
    },
  };

  const bodies = await loadCollectionEventBodies(
    executor,
    store,
    "tenant-replay",
    "audit_record",
  );

  assertEquals(bodies.length, EVENT_COUNT);
});
