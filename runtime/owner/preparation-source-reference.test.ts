import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { defineCollection } from "../collections/definition.ts";
import { contentSequenceSchema } from "../content/schema.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { digestContent } from "../content/digest.ts";
import { createOwnerCommandBoundary, type OwnerJson } from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import type { SqlSession } from "../events/session.ts";
import {
  createOwnerPreparationSource,
  type OwnerPreparationSourceOptions,
} from "./preparation-source.ts";
import type { PreparationSourceReference } from "./preparation-capture.ts";

async function fixture(
  options: {
    omitReferencePolicy?: boolean;
    referencePolicy?: OwnerPreparationSourceOptions["authorizeReference"];
  } = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  const store = createDatabaseBodyStore({ session: db, schema: "public" });
  const state = {
    allowed: true,
    namespace: "space",
    audience: "channel",
    projections: 0,
    referenceAllowed: true,
    hideTitle: false,
    bodyReads: 0,
    referenceChecks: [] as Parameters<
      NonNullable<OwnerPreparationSourceOptions["authorizeReference"]>
    >[1][],
  };
  const session: SqlSession = {
    query: db.query.bind(db),
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          query(sql, params) {
            if (sql.includes("substring(bytes")) state.bodyReads++;
            return tx.query(sql, params);
          },
        })
      ),
  };
  const source = createOwnerPreparationSource({
    ownerId: "owner",
    schema: "public",
    sources: {
      messages: {
        collection: defineCollection({
          name: "message",
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              namespace: { type: "string" },
              title: { type: "string" },
              content: contentSequenceSchema,
            },
            required: ["id", "namespace", "content"],
          } as const,
          content: { fields: ["content"] },
        }),
        contentPath: "content",
      },
    },
    authorize() {
      if (!state.allowed) throw new Error("current source denied");
      return { namespace: state.namespace, audience: state.audience };
    },
    ...(options.omitReferencePolicy ? {} : {
      authorizeReference: options.referencePolicy ?? ((_tx, context) => {
        state.referenceChecks.push(structuredClone(context));
        return state.referenceAllowed as true;
      }),
    }),
    projectRecord(record): OwnerJson {
      state.projections++;
      return state.hideTitle ? {} : { title: record.title };
    },
  });
  const boundary = createOwnerCommandBoundary({
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    session,
    handlers: {},
    // Fixture-only access to private methods. Production exposes no wire route
    // accepting caller-authored original provenance.
    projections: {
      ...source.projections,
      async capture(input, context) {
        return await source.capture(
          input as { source: string; recordId: string },
          context,
        ) as OwnerJson;
      },
      async original(input, context) {
        await source.authorizeOriginal(
          input as PreparationSourceReference,
          context,
          "duplicate",
        );
        return true;
      },
    },
    authorize() {},
    authenticateReceipt() {
      throw new Error("No receipt recovery");
    },
  });
  const ownerEpoch = await boundary.acquire(0);
  const caller = {
    ownerId: "owner",
    ownerEpoch,
    principal: { kind: "worker" as const, workerId: "worker" },
  };
  const add = async (id: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const digest = await digestContent(bytes);
    const bodyId = `body:${id}`;
    await store.put({ bodyId, bytes, digest, mediaType: "text/plain" });
    await db.query(
      "INSERT INTO nodes(id,namespace,type,name,data) VALUES($1,'space','asset',$1,$2)",
      [id, {
        state: "ready",
        bodyId,
        location: { kind: "database", key: bodyId },
        byteLength: bytes.length,
        digest,
        mediaType: "text/plain",
      }],
    );
    await db.query(
      "INSERT INTO edges(id,namespace,source_node_id,target_node_id,type) VALUES($1,'space','message-1',$2,'has_asset')",
      [`edge:${id}`, id],
    );
    return { assetId: id, kind: "text", role: "body", mediaType: "text/plain" };
  };
  await db.query(
    "INSERT INTO nodes(id,namespace,type,name,data) VALUES('message-1','space','message','message-1',$1)",
    [{ title: "Original title", content: [] }],
  );
  const ref = await add("asset-1", "original text");
  await db.query(
    "UPDATE nodes SET data=jsonb_set(data,'{content}',$1::jsonb) WHERE id='message-1'",
    [[ref]],
  );
  const capture = async () =>
    await boundary.project(caller, "capture", {
      source: "messages",
      recordId: "message-1",
    }) as unknown as Awaited<ReturnType<typeof source.capture>>;
  const verify = (reference: PreparationSourceReference) =>
    boundary.project(caller, "original", reference as OwnerJson);
  return {
    db,
    state,
    source,
    boundary,
    caller,
    capture,
    verify,
    add,
    async close() {
      boundary.stop();
      await db.close();
    },
  };
}

test("original preparation refs survive current field/title changes without reprojecting or selecting replacements", async () => {
  const f = await fixture();
  try {
    const first = await f.capture();
    assert.equal(first.reference.source.path, "content");
    assert.equal(first.reference.content[0].ref.assetId, "asset-1");
    assert.equal(
      JSON.stringify(first.reference).includes("original text"),
      false,
    );
    const replacement = await f.add("asset-2", "replacement text");
    await f.db.query("UPDATE nodes SET data=$1 WHERE id='message-1'", [{
      title: "Changed",
      content: [replacement],
    }]);
    const before = f.state.projections;
    assert.equal(await f.verify(first.reference), true);
    assert.equal(f.state.projections, before);
    const latest = await f.capture();
    assert.equal(latest.reference.content[0].ref.assetId, "asset-2");
    assert.notDeepEqual(latest.reference, first.reference);
    assert.equal(
      (first.projection as { record: { title: string } }).record.title,
      "Original title",
    );
  } finally {
    await f.close();
  }
});

test("original preparation refs reauthorize current source audience and exact immutable facts", async () => {
  const f = await fixture();
  try {
    const { reference } = await f.capture();
    f.state.allowed = false;
    await assert.rejects(f.verify(reference), /current source denied/);
    f.state.allowed = true;
    f.state.audience = "other";
    await assert.rejects(f.verify(reference), /preparation_forbidden/);
    f.state.audience = "channel";
    for (
      const source of [{ ...reference.source, namespace: "other" }, {
        ...reference.source,
        kind: "other",
      }, { ...reference.source, path: "other" }]
    ) {
      await assert.rejects(
        f.verify({ ...reference, source }),
        /preparation_forbidden/,
      );
    }
    const beforeMismatchedVersion = f.state.bodyReads;
    await assert.rejects(
      f.verify({
        ...reference,
        content: [{
          ...reference.content[0],
          version: {
            ...reference.content[0].version,
            digest: `sha256:${"0".repeat(64)}`,
          },
        }],
      }),
      /content_corrupted/,
    );
    assert.equal(f.state.bodyReads, beforeMismatchedVersion);
    await f.db.query(
      "INSERT INTO nodes(id,namespace,type,name,data) VALUES('other','space','message','other',$1)",
      [{ content: [] }],
    );
    await f.db.query(
      "UPDATE edges SET source_node_id='other' WHERE id='edge:asset-1'",
    );
    await assert.rejects(f.verify(reference), /preparation_forbidden/);
  } finally {
    await f.close();
  }
});

test("original preparation refs refuse deleted original assets even when replacement content remains valid", async () => {
  const f = await fixture();
  try {
    const { reference } = await f.capture();
    const replacement = await f.add("asset-2", "replacement text");
    await f.db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{content}',$1::jsonb) WHERE id='message-1'",
      [[replacement]],
    );
    await f.db.query("DELETE FROM nodes WHERE id='asset-1'");
    await assert.rejects(f.verify(reference), /content_missing/);
    assert.equal(
      (await f.capture()).reference.content[0].ref.assetId,
      "asset-2",
    );
    await f.db.query("DELETE FROM nodes WHERE id='message-1'");
    await assert.rejects(f.verify(reference), /content_missing/);
  } finally {
    await f.close();
  }
});

test("preparation source capture bounds the combined projection and provenance envelope", async () => {
  const source = createOwnerPreparationSource({
    ownerId: "owner",
    schema: "public",
    maxBytes: 1024,
    sources: {
      messages: {
        collection: defineCollection({
          name: "message",
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              namespace: { type: "string" },
              content: contentSequenceSchema,
            },
            required: ["id", "namespace", "content"],
          } as const,
          content: { fields: ["content"] },
        }),
        contentPath: "content",
      },
    },
    authorize: () => ({ namespace: "space", audience: "channel" }),
    authorizeReference: () => true,
    projectRecord: () => ({ title: "x".repeat(650) }),
  });
  await assert.rejects(
    source.capture({ source: "messages", recordId: "message-1" }, {
      tx: {
        query: () =>
          Promise.resolve({ rows: [{ data: { content: [] }, bytes: 14 }] }),
      } as never,
      caller: {
        principal: { kind: "worker", workerId: "worker" },
        ownerEpoch: 1,
      },
      commandTime: "2020-01-01T00:00:00.000Z",
      signal: new AbortController().signal,
    }),
    /preparation_limit/,
  );
});

test("original capture field-policy revocation refuses reuse before bodies without reprojecting", async () => {
  const f = await fixture();
  try {
    const { reference } = await f.capture();
    const reads = f.state.bodyReads;
    const projections = f.state.projections;
    f.state.hideTitle = true;
    f.state.referenceAllowed = false;
    assert.equal(f.state.allowed, true);
    await assert.rejects(
      f.verify(reference),
      /preparation_reference_forbidden/,
    );
    assert.equal(f.state.bodyReads, reads);
    assert.equal(f.state.projections, projections);
    assert.deepEqual(f.state.referenceChecks.at(-1)?.reference, reference);
    assert.equal(f.state.referenceChecks.at(-1)?.purpose, "duplicate");
    const current = await f.boundary.project(f.caller, "preparation.source", {
      source: "messages",
      recordId: "message-1",
    });
    assert.deepEqual((current as { record: unknown }).record, {});
    const afterRead = f.state.bodyReads;
    await assert.rejects(f.capture(), /preparation_reference_forbidden/);
    assert.equal(f.state.bodyReads, afterRead);
  } finally {
    await f.close();
  }
});

test("capture requires an explicit original-reference policy while read-only projection stays compatible", async () => {
  const f = await fixture({ omitReferencePolicy: true });
  try {
    await assert.rejects(f.capture(), /preparation_reference_forbidden/);
    assert.equal(f.state.bodyReads, 0);
    const projected = await f.boundary.project(f.caller, "preparation.source", {
      source: "messages",
      recordId: "message-1",
    });
    assert.equal(
      (projected as { record: { title: string } }).record.title,
      "Original title",
    );
    assert.ok(f.state.bodyReads > 0);
  } finally {
    await f.close();
  }
});

test("capture rechecks original permission at output with detached policy facts", async () => {
  let checks = 0;
  const references: PreparationSourceReference[] = [];
  const f = await fixture({
    referencePolicy(_tx, context) {
      checks++;
      references.push(structuredClone(context.reference));
      assert.equal(context.reference.source.namespace, "space");
      (context.reference.source as { namespace: string }).namespace =
        "callback mutation";
      return (checks === 1) as true;
    },
  });
  try {
    await assert.rejects(f.capture(), /preparation_reference_forbidden/);
    assert.equal(checks, 2);
    assert.ok(f.state.bodyReads > 0);
    assert.deepEqual(references[0], references[1]);
  } finally {
    await f.close();
  }
});
