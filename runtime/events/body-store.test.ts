import { assertEquals } from "@std/assert";
import { createCoreTableNames } from "./schema.ts";
import { type EventBodyStoreContext, writeEventBody } from "./body-store.ts";

Deno.test("event body writes canonicalize hydrated content refs", async () => {
  let stored: string | undefined;
  const context: EventBodyStoreContext = {
    transaction: {
      async query<TRow extends Record<string, unknown>>(
        _sql: string,
        params?: unknown[],
      ) {
        stored = String(params?.[3]);
        return {
          rows: [{
            namespace: String(params?.[0]),
            event_body_id: String(params?.[1]),
            schema_version: Number(params?.[2]),
            body: JSON.parse(stored),
            digest: String(params?.[4]),
            created_at: "2026-01-01T00:00:00.000Z",
          }] as unknown as TRow[],
        };
      },
    },
    tables: createCoreTableNames("event_body_canonicalization"),
  };

  await writeEventBody(context, {
    namespace: "tenant-a",
    id: "body-a",
    json: {
      ref: {
        assetId: "asset-a",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        value: "hydrated body",
        resolve: true,
        extra: "not durable",
      },
      metadata: {
        nested: {
          assetId: "asset-b",
          kind: "json",
          role: "attachment",
          mediaType: "application/json",
          value: { hydrated: true },
        },
      },
      ordinary: { label: "kept" },
    },
  });

  assertEquals(JSON.parse(stored!), {
    ref: {
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    },
    metadata: {
      nested: {
        assetId: "asset-b",
        kind: "json",
        role: "attachment",
        mediaType: "application/json",
      },
    },
    ordinary: { label: "kept" },
  });
});
