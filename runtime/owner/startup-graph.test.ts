import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CollectionDefinition,
  defineCollection,
  relation,
} from "../collections/definition.ts";
import { edgeId } from "../collections/ordinary-projection.ts";
import { validateCollectionRecord } from "../collections/validate.ts";
import { validateOwnerCollectionGraph } from "./startup-graph.ts";

const time = "2026-10-17T00:00:00.000Z";
const definition = defineCollection({
  name: "note",
  schema: {
    type: "object",
    required: ["id", "namespace", "title"],
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      title: { type: "string" },
    },
  },
  identity: { sourceType: "external", sourceField: "externalId" },
  search: { enabled: true, fields: ["title", "body"] },
});
function node(
  id = "n1",
  fields: Record<string, unknown> = {},
  type = "note",
  namespace = "tenant-a",
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id,
    namespace,
    title: "Note",
    createdAt: time,
    updatedAt: time,
    ...fields,
  };
  return {
    id,
    namespace,
    type,
    name: data.name ?? id,
    content: type === "note" ? "Note" : null,
    data,
    source_type: null,
    source_id: null,
    created_at: time,
    updated_at: time,
  };
}
function edge(
  source: string,
  target: string,
  type = "has_note",
  namespace = "tenant-a",
): Record<string, unknown> {
  return {
    id: edgeId(namespace, type, source, target),
    namespace,
    source_node_id: source,
    target_node_id: target,
    type,
    data: {},
    weight: 1,
    created_at: time,
  };
}
function check(
  nodes: readonly Record<string, unknown>[] = [],
  edges: readonly Record<string, unknown>[] = [],
  collections: readonly CollectionDefinition[] = [definition],
  extras: Partial<Parameters<typeof validateOwnerCollectionGraph>[0]> = {},
) {
  return validateOwnerCollectionGraph({
    ownerId: "owner",
    schema: "public",
    namespaces: ["tenant-a"],
    collections,
    nodes,
    edges,
    maxDerivedItems: 1000,
    maxDerivedBytes: 32 * 1024 * 1024,
    ...extras,
  });
}
function refused(
  nodes: readonly Record<string, unknown>[],
  edges: readonly Record<string, unknown>[] = [],
  collections: readonly CollectionDefinition[] = [definition],
  reason?: string,
) {
  const result = check(nodes, edges, collections);
  assert.ok(result.blockers.length, "graph should be blocked");
  if (reason) {
    assert.ok(
      result.blockers.some((blocker) => blocker.reason === reason),
      JSON.stringify(result.blockers),
    );
  }
}
const folder = defineCollection({ name: "folder", schema: { type: "object" } });
const related = (relations: CollectionDefinition["relations"]) =>
  defineCollection({ ...definition, relations });

test("empty or ordinary current graph is compatible without historical receipts", () => {
  assert.deepEqual(check(), {
    nodes: 0,
    edges: 0,
    derivedItems: 0,
    derivedBytes: 0,
    blockers: [],
  });
  const first = node("first", {
    externalId: "external-1",
    body: "ordinary content",
    commandProduced: { moved: true },
  });
  first.source_type = "external";
  first.source_id = "external-1";
  first.content = "Note\nordinary content";
  const before = structuredClone(first);
  const result = check([first]);
  assert.equal(result.nodes, 1);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(first, before);
});

test("custom explicit timestamps compare physical instants without normalization", () => {
  const custom = defineCollection({
    ...definition,
    timestamps: { createdAt: "created", updatedAt: "modified" },
  });
  const value = node("custom", {
    created: "2026-10-17T01:00:00+01:00",
    modified: time,
  });
  value.created_at = "2026-10-17 00:00:00+00";
  assert.deepEqual(check([value], [], [custom]).blockers, []);
  (value.data as Record<string, unknown>).modified = "2026-10-17T00:00:01Z";
  refused([value], [], [custom], "graph_timestamp_projection");
});

test("raw data must itself contain exact identity and survive strict schema validation", () => {
  for (
    const data of [null, [], "{}", 7, {}, {
      id: "wrong",
      namespace: "tenant-a",
    }]
  ) {
    refused([{ ...node(), data }]);
  }
  const bad = node();
  delete (bad.data as Record<string, unknown>).title;
  refused([bad], [], [definition], "graph_record_schema");
  for (const field of ["id", "namespace"]) {
    const value = node();
    delete (value.data as Record<string, unknown>)[field];
    refused([value], [], [definition], "graph_record_identity");
  }
});

test("identity search and timestamp projections must match exactly", () => {
  for (
    const patch of [
      { id: " n1" },
      { namespace: " tenant-a" },
      { type: "note " },
      { source_type: "external" },
      { source_id: "x" },
      { source_type: "", source_id: "" },
      { name: "renamed" },
      { content: "wrong" },
      { content: undefined },
      { created_at: null },
      { updated_at: "tomorrow" },
    ]
  ) refused([{ ...node(), ...patch }]);
  for (
    const patch of [
      { externalId: " x " },
      { externalId: 2 },
      { name: { hidden: "name" } },
      { createdAt: null },
      { updatedAt: "" },
    ]
  ) refused([node("n1", patch)]);
  const missing = node();
  delete (missing.data as Record<string, unknown>).createdAt;
  refused([missing], [], [definition], "graph_timestamp");
});

test("source identity uniqueness is per exact namespace and Collection type", () => {
  const first = node("one", { externalId: "same" });
  const second = node("two", { externalId: "same" });
  for (const value of [first, second]) {
    value.source_type = "external";
    value.source_id = "same";
  }
  refused([first, second], [], [definition], "graph_duplicate_identity");
  second.namespace = "tenant-b";
  (second.data as Record<string, unknown>).namespace = "tenant-b";
  assert.deepEqual(
    check([first, second], [], [definition], {
      namespaces: ["tenant-a", "tenant-b"],
    }).blockers,
    [],
  );
});

test("trusted namespace coverage is explicit and never inferred from rows", () => {
  refused(
    [node("n1", {}, "note", "foreign")],
    [],
    [definition],
    "graph_namespace",
  );
  assert.ok(
    check([node()], [], [definition], { namespaces: [] }).blockers.length,
  );
  assert.throws(
    () => check([], [], [definition], { namespaces: ["tenant-a", "tenant-a"] }),
    /graph_namespace_ambiguous/,
  );
  assert.throws(
    () => check([], [], [definition], { schema: "public.other" }),
    /Invalid PostgreSQL/,
  );
});

test("unsupported internal Collections are refused even when registered", () => {
  for (
    const type of [
      "asset",
      "protected_value",
      "@copilotz/action-content",
    ]
  ) {
    const declared = { ...definition, name: type } as CollectionDefinition;
    refused(
      [node("n1", {}, type)],
      [],
      [declared],
      "graph_collection_unsupported",
    );
  }
});

test("unknown kinds are refused unless they have an ordinary current definition", () => {
  refused(
    [node("n1", {}, "unknown")],
    [],
    [definition],
    "graph_collection_unsupported",
  );
});

test("unused well-formed F9 definitions do not certify or invalidate an empty graph", () => {
  const content = defineCollection({
    ...definition,
    content: { fields: ["attachments"] },
  });
  const secret = defineCollection({
    ...definition,
    schema: {
      type: "object",
      properties: { secret: { "x-copilotz-secret": true } as object },
    },
  });
  for (const unsupported of [content, secret]) {
    assert.deepEqual(check([], [], [unsupported]).blockers, []);
    refused([node()], [], [unsupported], "graph_collection_unsupported");
  }
});

test("nested partial and unknown-version markers reuse the shared guard", () => {
  for (
    const value of [
      { assetId: "a" },
      { bodyId: "b" },
      { ownerNodeId: null },
      { location: {} },
      { "$copilotz-secret": false },
      { "x-copilotz-secret": false },
      { schema: "copilotz.event.protected-value.v99" },
      { schema: [["copilotz.action.protected-value-aad.v2"]] },
    ]
  ) {
    refused(
      [node("n1", { arbitrary: [{ value }] })],
      [],
      [definition],
      "graph_nonordinary_value",
    );
  }
  assert.deepEqual(
    check([node("n1", { content: "ordinary text", ownerId: "business-owner" })])
      .blockers,
    [],
  );
});

test("malformed values fail without getters coercion defaults or hooks", () => {
  let calls = 0;
  const callable = defineCollection({
    ...definition,
    defaults: { added: "never" },
    beforeCreate() {
      calls++;
      return {};
    },
    commands: {
      unsafe: {
        mutate() {
          calls++;
          return {};
        },
      },
    },
  });
  const good = node();
  assert.deepEqual(check([good], [], [callable]).blockers, []);
  assert.equal((good.data as Record<string, unknown>).added, undefined);
  const bad = node();
  Object.defineProperty(bad.data, "value", {
    enumerable: true,
    get() {
      calls++;
      return "unsafe";
    },
  });
  refused([bad]);
  const getter = { ...callable };
  Object.defineProperty(getter, "schema", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => check([], [], [getter]), /graph_definition_accessor/);
  const nestedGetter = {
    ...callable,
    schema: Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        calls++;
        return "object";
      },
    }),
  };
  assert.throws(
    () => check([], [], [nestedGetter]),
    /graph_definition_accessor/,
  );
  assert.equal(calls, 0);
});

test("all declared names and declaration shapes are checked before use", () => {
  assert.throws(
    () => check([], [], [definition, { ...definition }]),
    /graph_definition_ambiguous/,
  );
  for (
    const patch of [
      { schema: null },
      { identity: { sourceType: "x" } },
      { search: { enabled: true, fields: "title" } },
      { timestamps: { other: "created" } },
      { relations: { broken: { type: "hasMany", collection: "folder" } } },
      { indexes: [{ fields: ["id"], unique: "yes" }] },
    ]
  ) {
    assert.throws(() =>
      check([], [], [{ ...definition, ...patch } as CollectionDefinition])
    );
  }
});

test("exact belongsTo hasOne and hasMany edges and inverse reads are compatible", () => {
  const parent = defineCollection({
    ...folder,
    relations: { notes: relation.hasMany("note", "folderId") },
  });
  const item = related({
    folder: relation.belongsTo("folder", "folderId"),
    companion: relation.hasOne("note", "companionId", "companion"),
    next: relation.hasMany("note", "nextIds", "next"),
  });
  const rows = [
    node("folder", {}, "folder"),
    node("one", { folderId: "folder", companionId: "two", nextIds: ["three"] }),
    node("two"),
    node("three"),
  ];
  assert.deepEqual(
    check(rows, [
      edge("folder", "one"),
      edge("one", "two", "companion"),
      edge("one", "three", "next"),
    ], [parent, item]).blockers,
    [],
  );
});

test("reversed relation directions and self references preserve reducer IDs", () => {
  const item = related({
    parent: relation.belongsTo("note", "parentId", "parent", "child-to-parent"),
    children: relation.hasMany(
      "note",
      "children",
      "children",
      "child-to-parent",
    ),
    one: relation.hasOne("note", "one", "one", "child-to-parent"),
  });
  assert.deepEqual(
    check([
      node("one", { parentId: "one", children: ["two"], one: "two" }),
      node("two"),
    ], [
      edge("one", "one", "parent"),
      edge("two", "one", "children"),
      edge("two", "one", "one"),
    ], [item]).blockers,
    [],
  );
});

test("explicit empty relation forms and absent inverse declarations are intentional", () => {
  const item = related({
    parent: relation.belongsTo("folder", "parent"),
    one: relation.hasOne("folder", "one", "one"),
    many: relation.hasMany("folder", "many", "many"),
  });
  for (
    const fields of [{}, { parent: null, one: "", many: [] }, {
      parent: "",
      one: null,
    }]
  ) {
    assert.deepEqual(
      check([node("n1", fields)], [], [folder, item]).blockers,
      [],
    );
  }
  for (
    const fields of [
      { parent: ["folder"] },
      { one: ["folder"] },
      { many: null },
      { many: "folder" },
      { many: ["folder", "folder"] },
      { parent: 1 },
    ]
  ) refused([node("n1", fields)], [], [folder, item]);
});

test("missing extra wrong-direction generic and malformed edges are refused", () => {
  const item = related({ folder: relation.belongsTo("folder", "folderId") });
  const rows = [
    node("folder", {}, "folder"),
    node("one", { folderId: "folder" }),
  ];
  refused(rows, [], [folder, item], "graph_edge_missing");
  for (
    const malformed of [
      edge("one", "folder"),
      edge("folder", "one", "other"),
      { ...edge("folder", "one"), id: "generic-id" },
      {
        ...edge("folder", "one"),
        data: { sourceType: "folder", targetType: "note", metadata: {} },
      },
      { ...edge("folder", "one"), weight: null },
      { ...edge("folder", "one"), weight: Infinity },
      { ...edge("folder", "one"), created_at: "invalid" },
      { ...edge("folder", "one"), data: "{}" },
      { ...edge("folder", "one"), namespace: "foreign" },
    ]
  ) refused(rows, [malformed], [folder, item]);
  refused([node("one"), node("two")], [edge("one", "two", "generic")], [
    definition,
  ], "graph_edge_undeclared");
});

test("dangling foreign keys wrong target kinds and cross-namespace endpoints remain blocked", () => {
  const item = related({ folder: relation.belongsTo("folder", "folderId") });
  refused(
    [node("one", { folderId: "absent" })],
    [],
    [folder, item],
    "graph_relation_target",
  );
  refused(
    [node("one", { folderId: "wrong" }), node("wrong")],
    [edge("wrong", "one")],
    [folder, item],
    "graph_relation_target",
  );
  const rows = [
    node("one", { folderId: "folder" }),
    node("folder", {}, "folder", "tenant-b"),
  ];
  const result = check(rows, [edge("folder", "one")], [folder, item], {
    namespaces: ["tenant-a", "tenant-b"],
  });
  assert.ok(
    result.blockers.some((blocker) =>
      blocker.reason === "graph_relation_target"
    ),
  );
  assert.ok(
    result.blockers.some((blocker) => blocker.reason === "graph_edge_endpoint"),
  );
});

test("same-key and opposing active relation writers are ambiguous even when empty", () => {
  const duplicate = related({
    one: relation.hasMany("folder", "one", "same"),
    two: relation.hasMany("folder", "two", "same"),
  });
  refused(
    [node("one", { one: [], two: [] })],
    [],
    [folder, duplicate],
    "graph_relation_ambiguous",
  );
  const parent = defineCollection({
    ...folder,
    relations: { children: relation.hasMany("note", "children") },
  });
  const child = related({ parent: relation.belongsTo("folder", "parent") });
  refused(
    [
      node("parent", { children: [] }, "folder"),
      node("child", { parent: null }),
    ],
    [],
    [parent, child],
    "graph_relation_ambiguous",
  );
});

test("active domains require supported related Collections even with no target", () => {
  for (
    const relationValue of [
      relation.belongsTo("missing", "parent"),
      relation.hasMany("asset", "targets"),
      { type: "reference", collection: "folder", foreignKey: "parent" },
    ]
  ) {
    const item = related(
      { parent: relationValue } as CollectionDefinition["relations"],
    );
    refused([node()], [], [item]);
  }
});

test("duplicate physical nodes and edges are rejected", () => {
  refused([node(), node()], [], [definition], "graph_duplicate_node");
  const item = related({ parent: relation.belongsTo("folder", "parent") });
  refused(
    [node("parent", {}, "folder"), node("one", { parent: "parent" })],
    [edge("parent", "one"), edge("parent", "one")],
    [folder, item],
    "graph_duplicate_edge",
  );
});

test("derived inventory and blocker capacity fail without partial success", () => {
  assert.throws(
    () => check([node()], [], [definition], { maxDerivedItems: 0 }),
    /inventory is incomplete/,
  );
  const item = related({
    targets: relation.hasMany("note", "targets", "targets"),
  });
  assert.throws(
    () =>
      check(
        [
          node("one", { targets: ["two", "three"] }),
          node("two"),
          node("three"),
        ],
        [],
        [item],
        { maxDerivedItems: 5 },
      ),
    /inventory is incomplete/,
  );
  assert.throws(
    () =>
      check(
        [{ ...node(), type: "unknown" }, { ...node("two"), type: "unknown" }],
        [],
        [definition],
        { maxBlockers: 1 },
      ),
    /inventory is incomplete/,
  );
  assert.throws(
    () => check(Array(10001).fill(node())),
    /inventory is incomplete/,
  );
});

test("JSON and declarative traversal cannot exceed finite bounds", () => {
  let nested: unknown = null;
  for (let index = 0; index < 33; index++) nested = { nested };
  refused(
    [node("one", { nested })],
    [],
    [definition],
    "graph_nonordinary_value",
  );
  assert.throws(
    () =>
      check([], [], [
        {
          ...definition,
          schema: { nested },
        } as unknown as CollectionDefinition,
      ]),
    /inventory is incomplete/,
  );
  assert.throws(
    () =>
      check([], [], [{
        ...definition,
        schema: { title: "x".repeat(1024 * 1024 + 1) },
      }]),
    /inventory is incomplete/,
  );
});

test("blockers expose only fixed bounded references and reasons", () => {
  const result = check([{
    ...node("secret-id", { confidential: "do not echo" }),
    type: "unknown",
  }]);
  assert.deepEqual(result.blockers, [{
    kind: "blocker",
    namespace: "tenant-a",
    id: "graph:node:0",
    reason: "graph_collection_unsupported",
  }]);
  assert.ok(!JSON.stringify(result).includes("do not echo"));
});

test("timestamp comparison retains microseconds and rejects lossy driver Dates", () => {
  for (const field of ["created_at", "updated_at"]) {
    refused([{ ...node(), [field]: "2026-10-17T00:00:00.000001Z" }], [], [
      definition,
    ], "graph_timestamp_projection");
    refused(
      [{ ...node(), [field]: new Date(time) }],
      [],
      [definition],
      "graph_timestamp",
    );
  }
  const value = node("precise", {
    createdAt: "2026-10-17T01:00:00.123456+01:00",
    updatedAt: "2026-10-17T00:00:00.000001Z",
  });
  value.created_at = "2026-10-17 00:00:00.123456+00";
  value.updated_at = "2026-10-17T00:00:00.000001Z";
  assert.deepEqual(check([value]).blockers, []);
  for (
    const createdAt of [
      "2026-02-30T00:00:00Z",
      "2026-10-17T00:00:00.1234567Z",
      "2026-10-17",
      "2026-10-17T24:00:00Z",
    ]
  ) refused([node("invalid", { createdAt })]);
});

test("projection byte expansion is reserved before descriptor materialization", () => {
  const repeated = defineCollection({
    ...definition,
    search: { enabled: true, fields: Array(128).fill("title") },
  });
  const value = node("large", { title: "x".repeat(1000) });
  assert.throws(
    () => check([value], [], [repeated], { maxDerivedBytes: 5000 }),
    /inventory is incomplete/,
  );
  assert.throws(
    () => check([node()], [], [definition], { maxDerivedBytes: 0 }),
    /inventory is incomplete/,
  );
  const item = related({
    targets: relation.hasMany("note", "targets", "edge".repeat(128)),
  });
  assert.throws(
    () =>
      check([node("one", { targets: ["two", "three"] })], [], [item], {
        maxDerivedBytes: 2000,
      }),
    /inventory is incomplete/,
  );
});

test("asynchronous schema contracts are refused before AJV runs", () => {
  const asynchronous = {
    ...definition,
    schema: { ...definition.schema as object, $async: true },
  } as CollectionDefinition;
  refused([node()], [], [asynchronous], "graph_collection_unsupported");
});

test("nested async schema declarations refuse without launching validation", () => {
  for (
    const schema of [
      { $async: true, type: "object", required: ["missingRequiredField"] },
      {
        type: "object",
        definitions: { nested: { $async: true, type: "string" } },
      },
      {
        type: "object",
        allOf: [{ $async: true, required: ["missingRequiredField"] }],
      },
    ]
  ) {
    refused(
      [node()],
      [],
      [{ ...definition, schema } as CollectionDefinition],
      "graph_collection_unsupported",
    );
  }
});

test("independent scans validate fresh current snapshots with stable schema IDs", () => {
  const identified = {
    ...definition,
    schema: {
      ...definition.schema as object,
      $id: "urn:copilotz:graph:repeat-proof",
    },
  } as CollectionDefinition;
  assert.deepEqual(check([node()], [], [identified]).blockers, []);
  assert.deepEqual(check([node()], [], [identified]).blockers, []);
});

test("prior ordinary writes do not collide with isolated captured schema IDs", () => {
  const identified = {
    ...definition,
    schema: {
      ...definition.schema as object,
      $id: "urn:copilotz:graph:already-written",
    },
  } as CollectionDefinition;
  const value = node();
  validateCollectionRecord(
    identified.schema as object,
    value.data as Record<string, unknown>,
    "ordinary write",
  );
  assert.deepEqual(check([value], [], [identified]).blockers, []);
});

test("distinct registered schemas cannot ambiguously claim one schema ID", () => {
  const first = {
    ...definition,
    schema: {
      ...definition.schema as object,
      $id: "urn:copilotz:graph:ambiguous",
    },
  } as CollectionDefinition;
  const second = {
    ...folder,
    schema: { type: "object", $id: "urn:copilotz:graph:ambiguous" },
  } as CollectionDefinition;
  assert.throws(() => check([], [], [first, second]), /already exists/);
});
