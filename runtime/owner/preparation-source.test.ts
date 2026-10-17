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
import {
  createOwnerPreparationSource,
  type OwnerPreparationSourceOptions,
} from "./preparation-source.ts";

const sourceCollection = () =>
  defineCollection({
    name: "message",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        title: { type: "string" },
        hidden: { type: "string" },
        content: contentSequenceSchema,
      },
      required: ["id", "namespace", "title", "content"],
      additionalProperties: false,
    } as const,
    content: { fields: ["content"] },
  });

type FixtureOptions = Partial<
  Pick<
    OwnerPreparationSourceOptions,
    "maxBytes" | "maxReferences" | "projectRecord"
  >
>;
async function fixture(options: FixtureOptions = {}) {
  const db = await createTestDatabase();
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  const store = createDatabaseBodyStore({ session: db, schema: "public" });
  let allowed = true;
  let namespace = "space";
  let audience = "public-channel";
  let policyCalls = 0;
  let policyHook:
    | ((
      context: Parameters<OwnerPreparationSourceOptions["authorize"]>[1],
    ) => void)
    | undefined;
  const collection = sourceCollection();
  const sources = { messages: { collection, contentPath: "content" } };
  const source = createOwnerPreparationSource({
    ownerId: "tenant",
    schema: "public",
    sources,
    ...options,
    authorize(_tx, context) {
      policyCalls++;
      if (
        !allowed || (context.caller.principal.kind === "worker"
            ? context.caller.principal.workerId
            : undefined) !== "worker" ||
        context.caller.ownerId !== "tenant"
      ) {
        throw Object.assign(new Error("scope refused"), {
          code: "scope_refused",
        });
      }
      policyHook?.(context);
      return { namespace, audience };
    },
    projectRecord: options.projectRecord ??
      ((record) => ({ title: record.title })),
  });
  const boundary = createOwnerCommandBoundary({
    session: db,
    schema: "public",
    ownerId: "tenant",
    holderId: "holder",
    handlers: {},
    projections: source.projections,
    authorize() {},
    authenticateReceipt() {
      throw new Error("no receipts");
    },
  });
  const epoch = await boundary.acquire(0);
  const caller = {
    principal: { kind: "worker" as const, workerId: "worker" },
    ownerEpoch: epoch,
    ownerId: "tenant",
  };
  const add = async (
    id: string,
    value: string | Uint8Array,
    kind = "text",
    owner = "message-1",
    ns = "space",
  ) => {
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value;
    const digest = await digestContent(bytes);
    const mediaType = kind === "json" ? "application/json" : "text/plain";
    const bodyId = `private-body:${id}`;
    await store.put({ bodyId, bytes, digest, mediaType });
    await db.query(
      "INSERT INTO nodes(id,namespace,type,name,data) VALUES($1,$2,'asset',$1,$3)",
      [id, ns, {
        bodyId,
        location: { kind: "database", key: bodyId },
        state: "ready",
        mediaType,
        digest,
        byteLength: bytes.length,
      }],
    );
    await db.query(
      "INSERT INTO edges(id,namespace,source_node_id,target_node_id,type) VALUES($1,$2,$3,$4,'has_asset')",
      [`edge:${id}`, ns, owner, id],
    );
    return { assetId: id, kind, role: "body", mediaType };
  };
  await db.query(
    "INSERT INTO nodes(id,namespace,type,name,data) VALUES('message-1','space','message','message-1',$1),('other','space','message','other',$2)",
    [
      { title: "Public title", hidden: "private field", content: [] },
      { title: "Other", content: [] },
    ],
  );
  const ref = await add("asset-1", "hello");
  const setContent = async (refs: OwnerJson[], id = "message-1") => {
    await db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{content}',$2::jsonb) WHERE id=$1",
      [id, refs],
    );
  };
  await setContent([ref]);
  return {
    db,
    boundary,
    caller,
    source,
    sources,
    collection,
    ref,
    add,
    setContent,
    setAllowed(value: boolean) {
      allowed = value;
    },
    setNamespace(value: string) {
      namespace = value;
    },
    setAudience(value: string) {
      audience = value;
    },
    setPolicyHook(hook: typeof policyHook) {
      policyHook = hook;
    },
    policyCalls: () => policyCalls,
    read(
      input: OwnerJson = { source: "messages", recordId: "message-1" },
      signal?: AbortSignal,
    ) {
      return boundary.project(
        caller,
        "preparation.source",
        input,
        signal ? { signal } : undefined,
      ) as Promise<Record<string, OwnerJson>>;
    },
    async close() {
      boundary.stop();
      await db.close();
    },
  };
}

test("preparation reader returns authorized logical versions and bounded text/JSON without writing captures", async () => {
  const f = await fixture();
  try {
    const json = await f.add("json", '{"answer":42}', "json");
    await f.setContent([f.ref, json]);
    const result = await f.read();
    assert.deepEqual(result.record, { title: "Public title" });
    assert.equal(result.audience, "public-channel");
    const content = result.content as {
      ref: OwnerJson;
      version: { digest: string; byteLength: number };
      value: OwnerJson;
    }[];
    assert.equal(content[0].value, "hello");
    assert.deepEqual(content[1].value, { answer: 42 });
    assert.equal(content[0].version.byteLength, 5);
    assert.equal(
      content[0].version.digest,
      await digestContent(new TextEncoder().encode("hello")),
    );
    for (
      const hidden of ["private field", "private-body", "location", "bodyId"]
    ) assert.equal(JSON.stringify(result).includes(hidden), false);
    assert.equal(f.policyCalls(), 2);
    for (const table of ["events", "event_bodies", "owner_receipts"]) {
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
    }
    const original = (result.source as { digest: string }).digest;
    await f.db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{title}','\"Updated\"') WHERE id='message-1'",
    );
    assert.notEqual(
      ((await f.read()).source as { digest: string }).digest,
      original,
    );
    // This reads current state; it deliberately does not promise capture replay.
  } finally {
    await f.close();
  }
});

test("preparation reader refuses caller-controlled scope, kind, field and asset selectors", async () => {
  const f = await fixture();
  try {
    for (
      const extra of ["namespace", "kind", "contentPath", "assetId", "ownerId"]
    ) {
      await assert.rejects(
        f.read({ source: "messages", recordId: "message-1", [extra]: "other" }),
        /preparation_invalid/,
      );
    }
    await assert.rejects(
      f.read({ source: "unknown", recordId: "message-1" }),
      /preparation_invalid/,
    );
    await assert.rejects(
      f.read({ source: "messages", recordId: "asset-1" }),
      /content_missing/,
    );
    f.setNamespace("other");
    await assert.rejects(f.read(), /content_missing/);
    f.setNamespace("space");
    await assert.rejects(
      f.boundary.project(
        { ...f.caller, ownerId: "other" },
        "preparation.source",
        { source: "messages", recordId: "message-1" },
      ),
      /scope refused/,
    );
    f.setAllowed(false);
    await assert.rejects(
      f.read({ source: "messages", recordId: "absent" }),
      /scope refused/,
    );
  } finally {
    await f.close();
  }
});

test("preparation reader enforces the sole exact domain owner and namespace before content release", async () => {
  const f = await fixture();
  try {
    const other = await f.add("foreign", "private", "text", "other");
    await f.setContent([other]);
    await assert.rejects(f.read(), /preparation_forbidden/);
    await f.setContent([f.ref]);
    await f.db.query(
      "INSERT INTO edges(id,namespace,source_node_id,target_node_id,type) VALUES('second','space','other','asset-1','has_asset')",
    );
    await assert.rejects(f.read(), /preparation_forbidden/);
    await f.db.query("DELETE FROM edges WHERE id='second'");
    await f.db.query(
      "UPDATE edges SET namespace='foreign' WHERE target_node_id='asset-1'",
    );
    await assert.rejects(f.read(), /preparation_forbidden/);
    await f.db.query(
      "UPDATE edges SET namespace='space' WHERE target_node_id='asset-1'",
    );
    await f.db.query("UPDATE nodes SET namespace='foreign' WHERE id='asset-1'");
    await assert.rejects(f.read(), /content_missing/);
  } finally {
    await f.close();
  }
});

test("preparation reader snapshots registration, policy arguments, records and returned refs", async () => {
  const f = await fixture({
    projectRecord(record, context) {
      (record as Record<string, OwnerJson>).content = [];
      (context.scope as { namespace: string }).namespace = "foreign";
      (context.request as { recordId: string }).recordId = "other";
      return { title: record.title };
    },
  });
  try {
    f.sources.messages.contentPath = "hidden";
    (f.collection as { name: string }).name = "asset";
    f.setPolicyHook((context) => {
      (context.request as { recordId: string }).recordId = "other";
      (context.caller as Record<string, unknown>).ownerId = "other";
    });
    const first = await f.read();
    assert.equal((first.source as { recordId: string }).recordId, "message-1");
    assert.equal((first.content as unknown[]).length, 1);
    (first.content as { value: string }[])[0].value = "tampered";
    assert.equal(
      ((await f.read()).content as { value: string }[])[0].value,
      "hello",
    );
    assert.equal(f.caller.ownerId, "tenant");
  } finally {
    await f.close();
  }
});

test("preparation reader fails missing, short and digest-mismatched immutable content explicitly", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "UPDATE content_body_parts SET bytes=$1 WHERE body_id='private-body:asset-1'",
      [new TextEncoder().encode("shorter")],
    );
    await assert.rejects(f.read(), /content_corrupted/);
    await f.db.query(
      "UPDATE content_body_parts SET bytes=$1 WHERE body_id='private-body:asset-1'",
      [new TextEncoder().encode("hi")],
    );
    await assert.rejects(f.read(), /incomplete|corrupted/);
    await f.db.query(
      "DELETE FROM content_bodies WHERE body_id='private-body:asset-1'",
    );
    await assert.rejects(f.read(), /content_missing/);
  } finally {
    await f.close();
  }
});

test("preparation reader refuses non-DB copies, non-ready bodies and forged head facts", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{location,kind}','\"object\"') WHERE id='asset-1'",
    );
    await assert.rejects(f.read(), /preparation_unsupported/);
    await f.db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{location,kind}','\"database\"') WHERE id='asset-1'",
    );
    await f.db.query(
      "UPDATE content_bodies SET state='incomplete' WHERE body_id='private-body:asset-1'",
    );
    await assert.rejects(f.read(), /content_corrupted/);
    await f.db.query(
      "UPDATE content_bodies SET state='ready',byte_length=6 WHERE body_id='private-body:asset-1'",
    );
    await assert.rejects(f.read(), /content_corrupted/);
    await f.db.query(
      "UPDATE content_bodies SET byte_length=5 WHERE body_id='private-body:asset-1'",
    );
    await f.db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{location,key}','\"another-copy\"') WHERE id='asset-1'",
    );
    await assert.rejects(f.read(), /content_missing/);
  } finally {
    await f.close();
  }
});

test("preparation reader rejects malformed UTF-8, malformed JSON and nested protected/content values", async () => {
  const f = await fixture();
  try {
    for (
      const [id, value, kind] of [
        ["utf8", new Uint8Array([0xff]), "text"],
        ["json", "{broken", "json"],
        ["protected", '{"$copilotz-secret":true}', "json"],
        ["nested", '{"nested":{"assetId":"foreign"}}', "json"],
      ] as const
    ) {
      const ref = await f.add(id, value, kind);
      await f.setContent([ref]);
      await assert.rejects(
        f.read(),
        /content_corrupted|preparation_unsupported/,
      );
    }
  } finally {
    await f.close();
  }
});

test("preparation reader aggregates repeated references and decoded-output bytes without truncation", async () => {
  const f = await fixture({ maxBytes: 1000, maxReferences: 2 });
  try {
    const ref = await f.add("large", "x".repeat(600));
    await f.setContent([ref, ref]);
    await assert.rejects(f.read(), /preparation_limit/);
    await f.setContent([f.ref, f.ref, f.ref]);
    await assert.rejects(f.read(), /preparation_limit/);
    const escaped = await f.add("escaped", "\n".repeat(700));
    await f.setContent([escaped]);
    await assert.rejects(f.read(), /preparation_limit/);
  } finally {
    await f.close();
  }
});

test("preparation reader refuses nested raw refs and protected fields from its mandatory record policy", async () => {
  for (
    const projected of [
      { nested: { assetId: "foreign" } },
      { nested: { location: { key: "private" } } },
      { nested: { "$copilotz-secret": true } },
    ] as OwnerJson[]
  ) {
    const f = await fixture({ projectRecord: () => projected });
    try {
      await assert.rejects(f.read(), /preparation_unsupported/);
    } finally {
      await f.close();
    }
  }
  const definition = sourceCollection();
  (definition.schema.properties.hidden as Record<string, unknown>)[
    "x-copilotz-secret"
  ] = true;
  assert.throws(() =>
    createOwnerPreparationSource({
      ownerId: "tenant",
      schema: "public",
      sources: { messages: { collection: definition, contentPath: "content" } },
      authorize: () => ({ namespace: "space", audience: "public" }),
      projectRecord: () => ({}),
    }), /preparation_unsupported/);
});

test("preparation reader rechecks current audience/revocation and cancellation at the output gate", async () => {
  const f = await fixture();
  try {
    f.setPolicyHook(() => {
      if (f.policyCalls() === 2) f.setAudience("different");
    });
    await assert.rejects(f.read(), /preparation_forbidden/);
    f.setAudience("public-channel");
    f.setPolicyHook(() => {
      if (f.policyCalls() === 3) f.setAllowed(false);
    });
    await assert.rejects(f.read(), /scope refused/);
    f.setAllowed(true);
    const controller = new AbortController();
    let calls = 0;
    f.setPolicyHook(() => {
      if (++calls === 2) controller.abort(new Error("output cancelled"));
    });
    await assert.rejects(
      f.read(undefined, controller.signal),
      /output cancelled/,
    );
    const aborted = new AbortController();
    aborted.abort(new Error("already cancelled"));
    await assert.rejects(
      f.read(undefined, aborted.signal),
      /already cancelled/,
    );
    await assert.rejects(
      f.boundary.project(
        { ...f.caller, ownerEpoch: f.caller.ownerEpoch + 1 },
        "preparation.source",
        { source: "messages", recordId: "message-1" },
      ),
      /epoch|stale|fenced/i,
    );
  } finally {
    await f.close();
  }
});

test("preparation version binds authorized projection and content without revealing hidden record guesses", async () => {
  const f = await fixture();
  try {
    const first = await f.read();
    const version = (first.source as { digest: string }).digest;
    const canonical = (value: OwnerJson): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value !== null && typeof value === "object") {
        return `{${
          Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${
              canonical((value as Record<string, OwnerJson>)[key])
            }`
          ).join(",")
        }}`;
      }
      return JSON.stringify(value);
    };
    const guessedPrivateRecord = {
      id: "message-1",
      namespace: "space",
      title: "Public title",
      hidden: "private field",
      content: [f.ref],
    };
    assert.notEqual(
      version,
      await digestContent(
        new TextEncoder().encode(canonical(guessedPrivateRecord)),
      ),
    );
    await f.db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{hidden}','\"different private value\"') WHERE id='message-1'",
    );
    assert.equal(
      ((await f.read()).source as { digest: string }).digest,
      version,
    );
    await f.db.query(
      "UPDATE nodes SET data=jsonb_set(data,'{title}','\"New public title\"') WHERE id='message-1'",
    );
    const publicVersion =
      ((await f.read()).source as { digest: string }).digest;
    assert.notEqual(publicVersion, version);
    const newRef = await f.add("new-body", "null", "json");
    await f.setContent([newRef]);
    const changed = await f.read();
    assert.notEqual(
      (changed.source as { digest: string }).digest,
      publicVersion,
    );
    assert.equal((changed.content as { value: OwnerJson }[])[0].value, null);
  } finally {
    await f.close();
  }
});

test("preparation reader rejects actual protected envelope schema markers without physical fields", async () => {
  let projected: OwnerJson = {};
  const f = await fixture({ projectRecord: () => projected });
  try {
    for (
      const [index, schema] of [
        "copilotz.action.lifecycle.protected.v1",
        "copilotz.action.protected-value.v1",
      ].entries()
    ) {
      projected = { nested: { schema } };
      await assert.rejects(f.read(), /preparation_unsupported/);
      projected = {};
      const ref = await f.add(
        `protected-marker-${index}`,
        JSON.stringify({ nested: { schema } }),
        "json",
      );
      await f.setContent([ref]);
      await assert.rejects(f.read(), /preparation_unsupported/);
      await f.setContent([f.ref]);
    }
  } finally {
    await f.close();
  }
});

test("preparation reader refuses reserved protected families in decoded bodies and projected fields", async () => {
  let projected: OwnerJson = { title: "Visible" };
  const f = await fixture({ projectRecord: () => projected });
  try {
    const markers: OwnerJson[] = [
      { schema: "copilotz.action.lifecycle.protected.v2" },
      { schema: "copilotz.action.protected-value.malformed" },
      { schema: "copilotz.action.protected-value-aad.v2" },
      { schema: "copilotz.event.protected-value" },
      { schema: ["copilotz.action.protected-value.v2"] },
      { ownerNodeId: "protected-owner" },
      { "x-copilotz-secret": false },
    ];
    for (const [index, nested] of markers.entries()) {
      const ref = await f.add(
        `protected-family-${index}`,
        JSON.stringify({ nested }),
        "json",
      );
      await f.setContent([ref]);
      await assert.rejects(f.read(), /preparation_unsupported/);
    }
    await f.setContent([f.ref]);
    for (const nested of markers) {
      projected = { nested };
      await assert.rejects(f.read(), /preparation_unsupported/);
    }
  } finally {
    await f.close();
  }
});
