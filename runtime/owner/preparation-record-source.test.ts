import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { PROTECTED_VALUE_REF_SCHEMA } from "../actions/protected-value.ts";
import {
  createOwnerCommandBoundary,
  type OwnerJson,
  type OwnerProjectionHandler,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerPreparationRecordSource,
  type OwnerPreparationRecordSourceOptions,
} from "./preparation-record-source.ts";
import type { PreparationSourceReference } from "./preparation-capture.ts";
const definition = () =>
  defineCollection({
    name: "note",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        namespace: { type: "string" },
        title: { type: "string" },
        hidden: { type: "string" },
      },
      required: ["id", "namespace", "title"],
    } as const,
  });
type SourceContext = Parameters<OwnerProjectionHandler>[1];
async function fixture(
  overrides: Partial<OwnerPreparationRecordSourceOptions> = {},
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  const state = {
    visible: true,
    original: true,
    audience: "context",
    namespace: "space",
    projected: 0,
    contexts: [] as Parameters<
      OwnerPreparationRecordSourceOptions["authorizeReference"]
    >[1][],
    projectHook: undefined as undefined | (() => void | Promise<void>),
    originalHook: undefined as undefined | (() => void | Promise<void>),
    sourceContext: undefined as SourceContext | undefined,
  };
  const registry = createPluginRegistry({
    collections: { note: definition() },
  });
  const sources = { notes: { collectionAlias: "note" } };
  const options: OwnerPreparationRecordSourceOptions = {
    ownerId: "owner",
    schema: "public",
    registry,
    sources,
    authorize(_tx, context) {
      assert.equal(context.ownerId, "owner");
      assert.deepEqual(context.caller.principal, {
        kind: "worker",
        workerId: "reader",
      });
      if (!state.visible) throw new Error("source refused");
      return { namespace: state.namespace, audience: state.audience };
    },
    async projectRecord(record) {
      state.projected++;
      await state.projectHook?.();
      return { title: record.title };
    },
    async authorizeReference(_tx, context) {
      state.contexts.push(structuredClone(context));
      await state.originalHook?.();
      return state.original as true;
    },
    ...overrides,
  };
  const source = createOwnerPreparationRecordSource(options);
  const boundary = createOwnerCommandBoundary({
    ownerId: "owner",
    holderId: "holder",
    schema: "public",
    session: db,
    handlers: {},
    projections: {
      ...source.projections,
      async capture(input, context) {
        state.sourceContext = context;
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
      throw new Error("No receipt access");
    },
  });
  const epoch = await boundary.acquire(0);
  const caller = {
    principal: { kind: "worker" as const, workerId: "reader" },
    ownerEpoch: epoch,
  };
  const write = (
    data: OwnerJson,
    id = "note-1",
    namespace = "space",
    kind = "note",
  ) =>
    db.query(
      "INSERT INTO nodes(id,namespace,type,name,data) VALUES($1,$2,$3,$1,$4) ON CONFLICT(id) DO UPDATE SET namespace=$2,type=$3,data=$4",
      [id, namespace, kind, data],
    );
  await write({ title: "Original", hidden: "private" });
  const capture = (signal?: AbortSignal) =>
    boundary.project(
      caller,
      "capture",
      { source: "notes", recordId: "note-1" },
      { signal },
    ) as unknown as Promise<Awaited<ReturnType<typeof source.capture>>>;
  const verify = (reference: PreparationSourceReference) =>
    boundary.project(caller, "original", reference);
  return {
    db,
    state,
    registry,
    sources,
    options,
    source,
    boundary,
    caller,
    capture,
    verify,
    write,
    async close() {
      boundary.stop();
      await db.close();
    },
  };
}
test("ordinary preparation source captures exact authorized Collection projection and hides raw fields", async () => {
  const f = await fixture();
  try {
    const value = await f.capture();
    assert("selection" in value.reference.source);
    assert.equal(value.reference.source.selection, "record");
    assert.equal(Object.hasOwn(value.reference.source, "path"), false);
    assert.deepEqual(value.reference.content, []);
    assert.deepEqual((value.projection as { record: unknown }).record, {
      title: "Original",
    });
    assert(!JSON.stringify(value).includes("private"));
    const stored = await f.db.query(
      "SELECT COUNT(*)::int AS count FROM events",
    );
    assert.equal(stored.rows[0].count, 0); // Reader has no orphan capture/body lifecycle.
    assert.equal(f.state.contexts.length, 2);
    assert.deepEqual(
      await f.boundary.project(f.caller, "preparation.source", {
        source: "notes",
        recordId: "note-1",
      }),
      value.projection,
    );
    f.state.visible = false;
    await assert.rejects(
      f.boundary.project(f.caller, "preparation.source", {
        source: "notes",
        recordId: "note-1",
      }),
      /source refused/,
    );
  } finally {
    await f.close();
  }
});
test("ordinary source digest changes only with authorized facts and original replay never reprojects", async () => {
  const f = await fixture();
  try {
    const first = await f.capture();
    await f.write({ title: "Original", hidden: "another private value" });
    assert.equal(
      (await f.capture()).reference.source.digest,
      first.reference.source.digest,
    );
    await f.write({ title: "Replacement", hidden: "another private value" });
    assert.notEqual(
      (await f.capture()).reference.source.digest,
      first.reference.source.digest,
    );
    const projected = f.state.projected;
    await f.verify(first.reference);
    assert.equal(f.state.projected, projected);
    assert.equal(
      f.state.contexts.at(-1)!.reference.source.digest,
      first.reference.source.digest,
    );
  } finally {
    await f.close();
  }
});
test("ordinary source original-field revocation denies reuse despite current row visibility", async () => {
  const f = await fixture();
  try {
    const original = await f.capture();
    const count = f.state.projected;
    f.state.original = false;
    await assert.rejects(
      f.verify(original.reference),
      /preparation_reference_forbidden/,
    );
    assert.equal(f.state.projected, count);
    assert.equal(f.state.visible, true);
    f.state.original = true;
    f.state.visible = false;
    await assert.rejects(f.verify(original.reference), /source refused/);
  } finally {
    await f.close();
  }
});
test("ordinary source rejects substituted source, namespace, kind, audience and content provenance", async () => {
  const f = await fixture();
  try {
    const original = (await f.capture()).reference;
    for (
      const source of [
        { ...original.source, name: "other" },
        { ...original.source, kind: "other" },
        { ...original.source, namespace: "other" },
        { ...original.source, recordId: "other" },
      ]
    ) await assert.rejects(f.verify({ ...original, source }));
    await assert.rejects(f.verify({ ...original, audience: "another" }));
    assert("selection" in original.source);
    const { selection: _selection, ...base } = original.source;
    await assert.rejects(
      f.verify({ ...original, source: { ...base, path: "content" } }),
      /preparation_forbidden/,
    );
    await f.write({ title: "wrong namespace" }, "note-1", "other");
    await assert.rejects(f.capture(), /preparation_source_missing/);
    await f.write({ title: "wrong kind" }, "note-1", "space", "different");
    await assert.rejects(f.capture(), /preparation_source_missing/);
  } finally {
    await f.close();
  }
});
test("ordinary source refuses undeclared nested refs and actual protected markers before projection", async () => {
  const f = await fixture();
  try {
    const markers: OwnerJson[] = [
      { assetId: "hidden" },
      { bodyId: "hidden" },
      { location: { kind: "database", key: "hidden" } },
      { schema: PROTECTED_VALUE_REF_SCHEMA },
      { schema: "copilotz.action.lifecycle.protected.v1" },
      { "$copilotz-secret": true },
    ];
    for (const nested of markers) {
      await f.write({ title: "Title", nested });
      await assert.rejects(f.capture(), /preparation_unsupported/);
    }
    assert.equal(f.state.projected, 0);
  } finally {
    await f.close();
  }
});
test("ordinary source rejects protected or content-shaped policy output", async () => {
  const f = await fixture({
    projectRecord: () => ({ nested: { schema: PROTECTED_VALUE_REF_SCHEMA } }),
  });
  try {
    await assert.rejects(f.capture(), /preparation_unsupported/);
  } finally {
    await f.close();
  }
});
test("ordinary source refuses reserved protected schema families before projection and output", async () => {
  let projected = 0;
  let output: OwnerJson = { title: "Visible" };
  const f = await fixture({
    projectRecord() {
      projected++;
      return output;
    },
  });
  try {
    const markers: OwnerJson[] = [
      { ownerNodeId: "protected-owner" },
      { "x-copilotz-secret": false },
      { schema: ["copilotz.action.protected-value.v2"] },
    ];
    for (
      const family of [
        "copilotz.action.lifecycle.protected",
        "copilotz.action.protected-value",
        "copilotz.action.protected-value-aad",
        "copilotz.event.protected-value",
      ]
    ) {
      for (const suffix of ["", ".v1", ".v2", ".malformed", "."]) {
        markers.push({ schema: `${family}${suffix}` });
      }
    }
    for (const nested of markers) {
      await f.write({ title: "Title", nested });
      await assert.rejects(f.capture(), /preparation_unsupported/);
    }
    assert.equal(projected, 0);
    await f.write({ title: "Ordinary" });
    for (const nested of markers) {
      output = { nested };
      await assert.rejects(f.capture(), /preparation_unsupported/);
    }
    // Reserved family matching is exact or dot-delimited, not a substring rule.
    for (
      const schema of [
        "app.copilotz.action.lifecycle.protected.v2",
        "copilotz.action.lifecycle.protectedness.v2",
      ]
    ) {
      output = { schema };
      const projection = (await f.capture()).projection;
      assert(
        projection && typeof projection === "object" &&
          !Array.isArray(projection),
      );
      assert("record" in projection);
      assert.deepEqual(projection.record, output);
    }
  } finally {
    await f.close();
  }
});
test("ordinary source snapshots registry, callbacks and detached policy arguments", async () => {
  let changed = 0;
  const f = await fixture();
  try {
    const mutable = f.options as {
      projectRecord: OwnerPreparationRecordSourceOptions["projectRecord"];
    };
    mutable.projectRecord = () => {
      changed++;
      return { title: "forged" };
    };
    f.sources.notes.collectionAlias = "missing";
    (f.registry.collections as Record<string, unknown>).note = defineCollection(
      { name: "replacement", schema: { type: "object" } },
    );
    const value = await f.capture();
    assert.equal(value.reference.source.kind, "note");
    assert.equal(changed, 0);
    // Stored audit snapshot can be changed without rebinding capture.
    (f.state.contexts[0].reference.source as { recordId: string }).recordId =
      "forged";
    await f.verify(value.reference);
    assert.equal(f.state.contexts.at(-1)!.reference.source.recordId, "note-1");
  } finally {
    await f.close();
  }
});
test("ordinary source retains original cancellation signal and time across awaited projection", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    f.state.projectHook = async () => {
      await Promise.resolve();
      const context = f.state.sourceContext as {
        signal: AbortSignal;
        commandTime: string;
      };
      context.signal = new AbortController().signal;
      context.commandTime = "2099-01-01T00:00:00.000Z";
      abort.abort(new Error("original cancelled"));
    };
    await assert.rejects(f.capture(abort.signal), /original cancelled/);
    f.state.projectHook = () => {
      (f.state.sourceContext as { commandTime: string }).commandTime =
        "2099-01-01T00:00:00.000Z";
    };
    await f.capture();
    assert(
      f.state.contexts.every((context) =>
        !context.commandTime.startsWith("2099")
      ),
    );
  } finally {
    await f.close();
  }
});
test("ordinary source rechecks original and current authority before output", async () => {
  const f = await fixture();
  try {
    f.state.projectHook = () => {
      f.state.visible = false;
    };
    await assert.rejects(f.capture(), /source refused/);
    f.state.visible = true;
    f.state.projectHook = undefined;
    let calls = 0;
    f.state.originalHook = () => {
      if (++calls === 2) f.state.original = false;
    };
    await assert.rejects(f.capture(), /preparation_reference_forbidden/);
  } finally {
    await f.close();
  }
});
test("ordinary source bounds combined projection and provenance without truncation", async () => {
  const f = await fixture({ maxBytes: 1024 });
  try {
    await f.write({ title: "x".repeat(650) });
    await assert.rejects(f.capture(), /preparation_limit/);
    await f.write({ title: "x".repeat(1100) });
    await assert.rejects(f.capture(), /preparation_limit/);
  } finally {
    await f.close();
  }
});
test("ordinary source registration fails closed for missing, content, secret and unsupported Collections", () => {
  const base = {
    ownerId: "owner",
    schema: "public",
    sources: { notes: { collectionAlias: "note" } },
    authorize: () => ({ namespace: "space", audience: "context" }),
    projectRecord: () => ({}),
    authorizeReference: () => true as const,
  };
  for (
    const collection of [
      undefined,
      { ...definition(), content: { fields: [] } },
      { ...definition(), schema: true },
      { ...definition(), schema: { type: "string" } },
      {
        ...definition(),
        schema: { type: "object", "x-copilotz-secret": true },
      },
    ]
  ) {
    assert.throws(() =>
      createOwnerPreparationRecordSource(
        {
          ...base,
          registry: { collections: collection ? { note: collection } : {} },
        } as OwnerPreparationRecordSourceOptions,
      )
    );
  }
  assert.throws(() =>
    createOwnerPreparationRecordSource(
      {
        ...base,
        registry: { collections: { note: definition() } },
        authorizeReference: undefined,
      } as unknown as OwnerPreparationRecordSourceOptions,
    )
  );
});

test("ordinary source registration refuses reserved owner node Collections", () => {
  const options = {
    ownerId: "owner",
    schema: "public",
    sources: { source: { collectionAlias: "source" } },
    authorize: () => ({ namespace: "space", audience: "context" }),
    projectRecord: () => ({}),
    authorizeReference: () => true as const,
  };
  // Both names are accepted by real Collection authoring/registry composition.
  // Registration still must keep the owner-owned storage types out of this reader.
  for (const name of ["asset", "protected_value"]) {
    const registry = createPluginRegistry({
      collections: {
        source: defineCollection({ name, schema: { type: "object" } as const }),
      },
    });
    assert.throws(
      () => createOwnerPreparationRecordSource({ ...options, registry }),
      /preparation_unsupported/,
    );
  }
  // A structurally supplied registry must not admit the retention owner either.
  // Public defineCollection already rejects this spelling as an event type.
  assert.throws(
    () =>
      createOwnerPreparationRecordSource({
        ...options,
        registry: {
          collections: {
            source: { ...definition(), name: "@copilotz/action-content" },
          },
        },
      }),
    /preparation_unsupported/,
  );
});

test("ordinary source policy argument mutation cannot rebind source, principal or original facts", async () => {
  const f = await fixture({
    authorize(_tx, context) {
      (context.request as { recordId: string }).recordId = "forged";
      (context.caller.principal as { workerId: string }).workerId = "forged";
      return { namespace: "space", audience: "context" };
    },
    projectRecord(record, context) {
      (record as Record<string, OwnerJson>).id = "forged";
      (context.scope as { namespace: string }).namespace = "forged";
      return { title: record.title };
    },
    authorizeReference(_tx, context) {
      (context.reference.source as { recordId: string }).recordId = "forged";
      (context.reference as { audience: string }).audience = "forged";
      (context.caller.principal as { workerId: string }).workerId = "forged";
      return true;
    },
  });
  try {
    const value = await f.capture();
    assert.equal(value.reference.source.recordId, "note-1");
    assert.equal(value.reference.source.namespace, "space");
    assert.equal(value.reference.audience, "context");
    assert.equal(f.caller.principal.workerId, "reader");
    await f.verify(value.reference);
  } finally {
    await f.close();
  }
});
