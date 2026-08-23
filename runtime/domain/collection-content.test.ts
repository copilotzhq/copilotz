import { assertEquals, assertExists, assertRejects } from "@std/assert";

import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import { createSqlSession } from "../events/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { defineCollection } from "../collections/index.ts";
import { type BodyStorageOptions, digestContent } from "../content/index.ts";
import { denoAssetFilesystem } from "../adapters/deno/assets.ts";

async function readEventBody(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  schema: string,
  eventType: string,
  subjectId?: string,
  order: "asc" | "desc" = "asc",
): Promise<Record<string, unknown>> {
  const subjectClause = subjectId ? "AND event.subject_id = $2" : "";
  const direction = order === "desc" ? "DESC" : "ASC";
  const result = await db.query<{ body: unknown }>(
    `SELECT body.body
       FROM "${schema}"."events" event
       JOIN "${schema}"."event_bodies" body
         ON body.namespace = event.namespace
        AND body.event_body_id = event.payload -> 'dataRef' ->> 'eventBodyId'
      WHERE event.type = $1
        ${subjectClause}
      ORDER BY event.position ${direction}
      LIMIT 1`,
    subjectId ? [eventType, subjectId] : [eventType],
  );
  const body = result.rows[0]?.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Missing event body for ${eventType}.`);
  }
  return body as Record<string, unknown>;
}

const contentOwnerCollection = defineCollection({
  name: "contract_content_owner",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      body: { type: "array" },
      reject: { type: "boolean" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "body"],
  } as const,
  content: { fields: ["body"] },
  commands: {
    replaceBody: {
      mutate({ input }) {
        return {
          set: {
            body: (input as { body?: unknown } | undefined)?.body,
          },
        };
      },
    },
  },
});

async function runCollectionContentContract(
  input: Readonly<{
    schema: string;
    assets?: BodyStorageOptions;
  }>,
): Promise<void> {
  const db = await createTestDatabase({ url: ":memory:" });
  const contentMatcher = defineProcessor({
    id: "contract-content.match-final-body",
    on: [{
      eventType: "contract_content_owner.created",
      data: {
        record: {
          body: [{ mediaType: "text/*" }],
        },
      },
    }],
    handle: () => undefined,
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.collection-content",
      version: "1.0.0",
      collections: { contentOwner: contentOwnerCollection },
      processors: { contentMatcher },
    })],
  });
  let nextId = 0;
  const engine = await createCopilotzEngine({
    session: createSqlSession(db),
    registry,
    defaultDatabaseSchema: input.schema,
    ...(input.assets ? { assets: input.assets } : {}),
    createId: () => `generated-${++nextId}`,
  });
  try {
    const scoped = engine.collections.withScope({
      namespace: "tenant-a",
    });
    const rejected = await engine.content.preparer.prepare("rolled back", {
      namespace: "tenant-a",
      idempotencyKey: "rejected-body",
    });
    const rejectedAssetId = rejected.content[0].assetId;
    await assertRejects(
      async () => {
        await scoped.contract_content_owner.create({
          id: "rejected-owner",
          body: rejected,
          forbidden: true,
        });
      },
      Error,
      "schema validation",
    );
    assertEquals(
      await engine.content.assets.get("tenant-a", rejectedAssetId),
      null,
    );
    await assertRejects(
      async () => {
        await scoped.contract_content_owner.create({
          id: "missing-body",
        } as never);
      },
      TypeError,
      "schema validation",
    );
    await assertRejects(
      async () => {
        await scoped.contract_content_owner.create({
          id: "null-body",
          body: null,
        } as never);
      },
      Error,
      "Durable content",
    );

    const empty = await scoped.contract_content_owner.create({
      id: "empty-owner",
      body: [],
    });
    assertEquals(empty.body, []);
    const emptyBody = await readEventBody(
      db,
      input.schema,
      "contract_content_owner.created",
      "empty-owner",
    );
    assertEquals(emptyBody.assets, []);

    const first = await engine.content.preparer.prepare("first body", {
      namespace: "tenant-a",
      idempotencyKey: "first-body",
    });
    const created = await scoped.contract_content_owner.create({
      id: "content-owner",
      body: first,
    });
    assertEquals(created.body, first.content);
    const createdBody = await readEventBody(
      db,
      input.schema,
      "contract_content_owner.created",
      "content-owner",
    );
    const createdAssets = createdBody.assets as Record<string, unknown>[];
    assertEquals(createdAssets.length, 1);
    assertEquals(createdAssets[0].assetId, first.content[0].assetId);
    assertEquals(typeof createdAssets[0].bodyId, "string");
    assertEquals(typeof createdAssets[0].location, "object");
    const matchedDeliveries = await db.query<{ n: string | number }>(
      `SELECT count(*)::int AS n
       FROM "${input.schema}"."event_deliveries" delivery
       JOIN "${input.schema}"."events" event
         ON event.id = delivery.event_id
      WHERE event.type = $1
        AND delivery.consumer_id = $2`,
      [
        "contract_content_owner.created",
        "processor:contract-content.match-final-body",
      ],
    );
    assertEquals(Number(matchedDeliveries.rows[0]?.n ?? 0), 1);
    assertEquals(
      new TextDecoder().decode(
        (await engine.content.assets.read(
          "tenant-a",
          first.content[0].assetId,
        )).bytes,
      ),
      "first body",
    );

    const second = await engine.content.preparer.prepare("second body", {
      namespace: "tenant-a",
      idempotencyKey: "second-body",
    });
    const updated = await scoped.contract_content_owner.update({
      id: "content-owner",
      set: { body: second },
    });
    assertEquals(updated.body, second.content);
    const updatedBody = await readEventBody(
      db,
      input.schema,
      "contract_content_owner.updated",
      "content-owner",
    );
    const updatedAssets = updatedBody.assets as Record<string, unknown>[];
    assertEquals(updatedAssets.length, 1);
    assertEquals(updatedAssets[0].assetId, second.content[0].assetId);

    const third = await engine.content.preparer.prepare("third body", {
      namespace: "tenant-a",
      idempotencyKey: "third-body",
    });
    const commanded = await scoped.contract_content_owner.commands.replaceBody({
      id: "content-owner",
      body: third,
    });
    assertEquals(commanded.body, third.content);
    const commandBody = await readEventBody(
      db,
      input.schema,
      "contract_content_owner.updated",
      "content-owner",
      "desc",
    );
    assertEquals(commandBody.operation, "update");
    const commandAssets = commandBody.assets as Record<string, unknown>[];
    assertEquals(commandAssets.length, 1);
    assertEquals(commandAssets[0].assetId, third.content[0].assetId);

    const links = await db.query<{
      source_node_id: string;
      target_node_id: string;
    }>(
      `SELECT source_node_id, target_node_id
       FROM "${input.schema}"."edges"
       WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
      ["tenant-a", "content-owner"],
    );
    assertEquals(links.rows, [{
      source_node_id: "content-owner",
      target_node_id: third.content[0].assetId,
    }]);
    await assertRejects(
      async () => {
        await scoped.contract_content_owner.update({
          id: "content-owner",
          unset: ["body"],
        });
      },
      TypeError,
      "schema validation",
    );
    assertEquals(
      (await scoped.contract_content_owner.get({ id: "content-owner" }))?.body,
      third.content,
    );

    const refOnly = await scoped.contract_content_owner.create({
      id: "ref-owner",
      body: [third.content[0], third.content[0]],
    });
    assertEquals(refOnly.body, [third.content[0], third.content[0]]);
    const refOnlyBody = await readEventBody(
      db,
      input.schema,
      "contract_content_owner.created",
      "ref-owner",
    );
    assertEquals(refOnlyBody.assets, []);
    const refLinks = await db.query<{
      source_node_id: string;
      target_node_id: string;
    }>(
      `SELECT source_node_id, target_node_id
       FROM "${input.schema}"."edges"
       WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
      ["tenant-a", "ref-owner"],
    );
    assertEquals(refLinks.rows, [{
      source_node_id: "ref-owner",
      target_node_id: third.content[0].assetId,
    }]);
    await scoped.contract_content_owner.delete({ id: "ref-owner" });
    assertEquals(
      await scoped.contract_content_owner.get({ id: "ref-owner" }),
      null,
    );
    const deletedBody = await readEventBody(
      db,
      input.schema,
      "contract_content_owner.deleted",
      "ref-owner",
    );
    assertEquals(deletedBody.assets, []);
    assertEquals(
      await db.query<{ n: string | number }>(
        `SELECT count(*)::int AS n
         FROM "${input.schema}"."edges"
         WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
        ["tenant-a", "ref-owner"],
      ).then((result) => Number(result.rows[0]?.n ?? 0)),
      0,
    );

    const sequential = await engine.content.preparer.prepare(
      "sequential body",
      {
        namespace: "tenant-a",
        idempotencyKey: "sequential-body",
      },
    );
    await engine.collections.transaction({
      operationKey: "content:create-update",
      namespace: "tenant-a",
      async execute({ collections }) {
        await collections.contract_content_owner.create({
          id: "sequential-owner",
          body: sequential,
        });
        await collections.contract_content_owner.update({
          id: "sequential-owner",
          set: { reject: false },
        });
      },
    });
    assertEquals(
      (await scoped.contract_content_owner.get({ id: "sequential-owner" }))
        ?.body,
      sequential.content,
    );

    const deletedInPlan = await engine.content.preparer.prepare(
      "deleted in plan",
      {
        namespace: "tenant-a",
        idempotencyKey: "deleted-in-plan",
      },
    );
    await engine.collections.transaction({
      operationKey: "content:create-delete",
      namespace: "tenant-a",
      async execute({ collections }) {
        await collections.contract_content_owner.create({
          id: "deleted-plan-owner",
          body: deletedInPlan,
        });
        await collections.contract_content_owner.delete({
          id: "deleted-plan-owner",
        });
      },
    });
    assertEquals(
      await scoped.contract_content_owner.get({ id: "deleted-plan-owner" }),
      null,
    );
    assertExists(
      await engine.content.assets.get(
        "tenant-a",
        deletedInPlan.content[0].assetId,
      ),
    );

    const sameKeyFirst = await engine.content.preparer.prepare(
      "same transaction body",
      {
        namespace: "tenant-a",
        idempotencyKey: "same-transaction-key",
      },
    );
    const sameKeySecond = await engine.content.preparer.prepare(
      "same transaction body",
      {
        namespace: "tenant-a",
        idempotencyKey: "same-transaction-key",
      },
    );
    await engine.collections.transaction({
      operationKey: "content:same-key",
      namespace: "tenant-a",
      async execute({ collections }) {
        await collections.contract_content_owner.create({
          id: "same-key-owner-a",
          body: sameKeyFirst,
        });
        await collections.contract_content_owner.create({
          id: "same-key-owner-b",
          body: sameKeySecond,
        });
      },
    });
    const sameKeyOwners = await Promise.all([
      scoped.contract_content_owner.get({ id: "same-key-owner-a" }),
      scoped.contract_content_owner.get({ id: "same-key-owner-b" }),
    ]);
    assertEquals(
      (sameKeyOwners[0]?.body as { assetId: string }[])[0].assetId,
      (sameKeyOwners[1]?.body as { assetId: string }[])[0].assetId,
    );

    const conflictBase = await engine.content.preparer.prepare(
      "conflict base",
      {
        namespace: "tenant-a",
        idempotencyKey: "conflict-base",
      },
    );
    const conflictingBytes = new TextEncoder().encode("conflicting bytes");
    const conflictingPrepared = Object.freeze({
      content: conflictBase.content,
      assets: Object.freeze([Object.freeze({
        ...conflictBase.assets[0],
        body: conflictingBytes,
        byteLength: conflictingBytes.byteLength,
        digest: await digestContent(conflictingBytes),
      })]),
    });
    await assertRejects(
      () =>
        engine.collections.transaction({
          operationKey: "content:conflicting-staged-id",
          namespace: "tenant-a",
          async execute({ collections }) {
            await collections.contract_content_owner.create({
              id: "conflict-owner-a",
              body: conflictBase,
            });
            await collections.contract_content_owner.create({
              id: "conflict-owner-b",
              body: conflictingPrepared,
            });
          },
        }),
      Error,
      "conflicts with an earlier transaction mutation",
    );
    assertEquals(
      await scoped.contract_content_owner.get({ id: "conflict-owner-a" }),
      null,
    );
    await assertRejects(
      () =>
        engine.content.assets.markDeleted(
          "tenant-a",
          third.content[0].assetId,
        ),
      Error,
      "still referenced by declared Collection content",
    );

    const raced = await engine.content.preparer.prepare("raced body", {
      namespace: "tenant-a",
      idempotencyKey: "raced-body",
    });
    const racedRefs = await engine.content.assets.materialize({
      namespace: "tenant-a",
      content: raced,
    });
    let notifyStaged!: () => void;
    let releaseCommit!: () => void;
    const staged = new Promise<void>((resolve) => notifyStaged = resolve);
    const released = new Promise<void>((resolve) => releaseCommit = resolve);
    const racedTransaction = engine.collections.transaction({
      operationKey: "content:delete-race",
      namespace: "tenant-a",
      async execute({ collections }) {
        await collections.contract_content_owner.create({
          id: "raced-owner",
          body: racedRefs,
        });
        notifyStaged();
        await released;
      },
    });
    const racedRejection = assertRejects(
      () => racedTransaction,
      Error,
      "non-ready Asset",
    );
    await staged;
    await engine.content.assets.markDeleted(
      "tenant-a",
      racedRefs[0].assetId,
    );
    releaseCommit();
    await racedRejection;
    assertEquals(
      await scoped.contract_content_owner.get({ id: "raced-owner" }),
      null,
    );
    assertExists(
      await engine.content.assets.get("tenant-a", first.content[0].assetId),
    );
    await db.query(
      `DELETE FROM "${input.schema}"."nodes"
       WHERE namespace = $1`,
      ["tenant-a"],
    );
    await engine.collections.rebuild("tenant-a");
    const rebuilt = await scoped.contract_content_owner.get({
      id: "content-owner",
    });
    assertEquals(rebuilt?.body, third.content);
    const replayLinks = await db.query<{
      source_node_id: string;
      target_node_id: string;
    }>(
      `SELECT source_node_id, target_node_id
       FROM "${input.schema}"."edges"
       WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
      ["tenant-a", "content-owner"],
    );
    assertEquals(replayLinks.rows, [{
      source_node_id: "content-owner",
      target_node_id: third.content[0].assetId,
    }]);
    const replayPins = await db.query<{ id: string }>(
      `SELECT id
       FROM "${input.schema}"."nodes"
       WHERE namespace = $1 AND type = 'asset'
         AND data ->> 'state' = 'ready'
         AND data ->> 'bodyId' = $2`,
      ["tenant-a", commandAssets[0].bodyId],
    );
    assertEquals(replayPins.rows, [{ id: third.content[0].assetId }]);
  } finally {
    await engine.shutdown();
    await db.close();
  }
}

Deno.test("custom collection content materializes and links atomically with database bodies", async () => {
  await runCollectionContentContract({
    schema: "collection_content_contract",
  });
});

Deno.test("custom collection content materializes and links atomically with filesystem bodies", async () => {
  const root = await Deno.makeTempDir({
    prefix: "copilotz-collection-content-",
  });
  try {
    await runCollectionContentContract({
      schema: "collection_content_filesystem_contract",
      assets: {
        storage: {
          type: "filesystem",
          config: {
            backendId: "filesystem:collection-content",
            prefix: "collection-content",
            protectionMs: 5_000,
            access: denoAssetFilesystem(root),
          },
        },
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
