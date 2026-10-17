import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnerStartupProof } from "./startup.ts";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerPreparations } from "./preparation.ts";
import { createOwnerPreparationRecordSource } from "./preparation-record-source.ts";
function unavailable(): never {
  throw new Error("History facts cannot invoke callbacks or SQL");
}
function fixture() {
  const collection = defineCollection({
    name: "note",
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
    } as const,
  });
  const registry = createPluginRegistry({
    collections: { note: collection },
    actions: { child: defineAction({ id: "child", execute: unavailable }) },
    resources: { context: { style: { secret: "must not be captured" } } },
  });
  const sources = { notes: { collectionAlias: "note" } };
  const source = createOwnerPreparationRecordSource({
    ownerId: "owner",
    schema: "public",
    registry,
    sources,
    authorize: unavailable,
    projectRecord: unavailable,
    authorizeReference: unavailable,
  });
  const preparations = {
    context: {
      source: "notes",
      actionAlias: "child",
      shows: "note",
      modes: ["context"],
      resources: [{ namespace: "context", alias: "style" }],
      mapInput: unavailable,
    },
  };
  const helper = createOwnerPreparations({
    ownerId: "owner",
    schema: "public",
    registry,
    source,
    children: {
      authorizeTarget: unavailable,
      inspectPrepared: unavailable,
      admitPrepared: unavailable,
    },
    preparations,
    projectResource: unavailable,
    authorizeResource: unavailable,
  });
  return { registry, sources, preparations, source, helper };
}
test("preparation history facts are constructor-derived detached inert data", () => {
  const f = fixture();
  const sourceFacts = [{ name: "notes", kind: "note", selection: "record" }];
  const preparedFacts = [{
    name: "context",
    source: "notes",
    actionId: "child",
    modes: ["context"],
    resources: [{ namespace: "context", alias: "style" }],
  }];
  assert.deepEqual(f.source.historySources(), sourceFacts);
  assert.deepEqual(f.helper.historyRegistrations(), preparedFacts);
  f.sources.notes.collectionAlias = "other";
  f.preparations.context.source = "other";
  f.preparations.context.actionAlias = "other";
  f.preparations.context.modes.push("other");
  f.preparations.context.resources[0].alias = "other";
  Reflect.set(f.registry.collections.note, "name", "other");
  Reflect.set(f.registry.actions.child, "id", "other");
  const a = f.source.historySources(), b = f.helper.historyRegistrations();
  Reflect.set(a[0], "kind", "caller mutation");
  Reflect.set(b[0], "actionId", "caller mutation");
  Reflect.set(b[0].modes, "0", "caller mutation");
  Reflect.set(b[0].resources[0], "namespace", "caller mutation");
  assert.deepEqual(f.source.historySources(), sourceFacts);
  assert.deepEqual(f.helper.historyRegistrations(), preparedFacts);
});
test("preparation history capture does not invoke resource accessors", () => {
  let read = 0;
  const registry = createPluginRegistry({
    actions: { child: defineAction({ id: "child", execute: unavailable }) },
  });
  assert.throws(() =>
    createOwnerPreparations({
      ownerId: "owner",
      schema: "public",
      registry,
      source: {
        capture: unavailable,
        authorizeOriginal: unavailable,
        projections: { "preparation.source": unavailable },
      },
      children: {
        authorizeTarget: unavailable,
        inspectPrepared: unavailable,
        admitPrepared: unavailable,
      },
      preparations: {
        context: {
          source: "notes",
          actionAlias: "child",
          shows: "note",
          modes: ["context"],
          resources: [{
            namespace: "context",
            get alias() {
              read++;
              return "style";
            },
          }],
          mapInput: unavailable,
        },
      },
      projectResource: unavailable,
      authorizeResource: unavailable,
    })
  );
  assert.equal(read, 0);
});

test("startup preparation configuration refuses malformed, unknown source/target and oversized facts before SQL", () => {
  const f = fixture();
  const prepared = f.helper.historyRegistrations().map((
    { source, ...value },
  ) => ({
    ...value,
    source: { name: source, kind: "note", selection: "record" as const },
  }));
  const options = {
    ownerId: "owner",
    schema: "public",
    registry: f.registry,
    namespaces: ["space"],
    prepared,
    authorizeControl: unavailable,
  };
  assert.doesNotThrow(() => createOwnerStartupProof(options));
  for (
    const bad of [
      null,
      false,
      "records",
      [{ ...prepared[0], source: { ...prepared[0].source, kind: "foreign" } }],
      [{ ...prepared[0], actionId: "foreign" }],
      [{ ...prepared[0], modes: [] }],
      [prepared[0], prepared[0]],
      [{
        ...prepared[0],
        resources: [{ namespace: "space", alias: "a", extra: true }],
      }],
    ]
  ) {
    assert.throws(() =>
      createOwnerStartupProof({ ...options, prepared: bad as never })
    );
  }
  assert.throws(
    () => createOwnerStartupProof({ ...options, maxItems: 5 }),
    /budget|node|limit/i,
  );
  assert.throws(
    () => createOwnerStartupProof({ ...options, namespaces: undefined }),
    /registration/,
  );
});

test("startup refuses reserved, content and secret source Collections even when graph registration retains them", () => {
  const unsupported = [
    ...["asset", "protected_value"].map((name) =>
      defineCollection({ name, schema: { type: "object" } as const })
    ),
    defineCollection({
      name: "content_note",
      schema: { type: "object" } as const,
      content: { fields: ["body"] },
    }),
    defineCollection({
      name: "secret_note",
      schema: {
        type: "object",
        properties: { hidden: { type: "string", "x-copilotz-secret": true } },
      } as const,
    }),
    defineCollection({
      name: "scalar_note",
      schema: { type: "string" } as const,
    }),
  ];
  for (const collection of unsupported) {
    const name = collection.name;
    const registry = createPluginRegistry({
      collections: { source: collection },
      actions: { child: defineAction({ id: "child", execute: unavailable }) },
    });
    assert.throws(() =>
      createOwnerStartupProof({
        ownerId: "owner",
        schema: "public",
        registry,
        namespaces: ["space"],
        prepared: [{
          name: "context",
          actionId: "child",
          source: { name: "notes", kind: name, selection: "record" },
          modes: ["context"],
          resources: [],
        }],
        authorizeControl: unavailable,
      }), /registration/);
  }
});
