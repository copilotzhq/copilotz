import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssetManifestEntry } from "../content/types.ts";
import { defineCollection, relation } from "./definition.ts";
import type { CollectionDefinition } from "./definition.ts";
import {
  composeCollectionProjection,
  type ProjectionGuard,
} from "./reducer.ts";
import type { CollectionEventBody, CollectionRecord } from "./types.ts";

const time = "2026-10-17T00:00:00.123456Z";
const base = defineCollection({ name: "item", schema: { type: "object" } });
// Direct reducer fixtures retain the existing SQL fallback for omitted times.
const record = { id: "i1", namespace: "tenant" } as CollectionRecord;
const ordinary = defineCollection({
  ...base,
  timestamps: { createdAt: "created", updatedAt: "modified" },
  search: { enabled: true, fields: ["title", "blank", "count", "title"] },
  identity: { sourceType: "external", sourceField: "externalId" },
});
const related = defineCollection({
  ...base,
  relations: {
    parent: relation.belongsTo("parent", "parentId"),
    reverseParent: relation.belongsTo(
      "parent",
      "reverseParentId",
      "reverse_parent",
      "child-to-parent",
    ),
    many: relation.hasMany("tag", "tagIds"),
    reverseMany: relation.hasMany(
      "tag",
      "reverseTagIds",
      "reverse_tags",
      "child-to-parent",
    ),
    one: relation.hasOne("other", "otherId"),
    reverseOne: relation.hasOne(
      "other",
      "reverseOtherId",
      "reverse_one",
      "child-to-parent",
    ),
  },
});
const overlap = defineCollection({
  ...base,
  relations: {
    first: relation.hasMany("tag", "first", "shared"),
    last: relation.hasMany("tag", "last", "shared"),
  },
});
const content = defineCollection({
  ...ordinary,
  content: { fields: ["attachments", "nested.refs"] },
  relations: { parent: relation.belongsTo("parent", "parentId") },
});
const ref = (assetId: string, mediaType = "text/plain") => ({
  assetId,
  kind: "text",
  role: "attachment",
  mediaType,
});
const manifest: AssetManifestEntry = {
  assetId: "a1",
  bodyId: "body-a1",
  mediaType: "text/plain",
  byteLength: 3,
  digest: "sha256:abc",
  location: { kind: "database", key: "body-a1" },
  createdAt: time,
  idempotencyKey: "asset-key",
  origin: { type: "source", id: "origin" },
  metadata: { label: "A" },
};

type Fixture = Readonly<{
  definition: CollectionDefinition;
  value?: Record<string, unknown>;
  operation?: "create" | "update" | "delete";
  assets?: readonly AssetManifestEntry[];
  guard?: ProjectionGuard;
}>;

// These fixtures intentionally include inputs outside startup's supported
// subset. Sharing derivation must not narrow existing reducer behavior.
export const projectionFixtures: Readonly<Record<string, Fixture>> = {
  minimal: { definition: base },
  node: {
    definition: ordinary,
    value: {
      name: 0,
      title: "  Title  ",
      blank: "  ",
      count: 7,
      externalId: " ext ",
      created: time,
      modified: "2026-10-18T00:00:00Z",
    },
  },
  update: {
    definition: ordinary,
    operation: "update",
    value: { name: { x: 1 }, externalId: 7, created: "", modified: null },
  },
  delete: {
    definition: content,
    operation: "delete",
    value: { created: "invalid", parentId: [" "], attachments: [ref("a1")] },
    assets: [manifest],
  },
  relations: {
    definition: related,
    value: {
      parentId: [" p1 ", "unused-parent"],
      reverseParentId: "p2",
      tagIds: ["t1", "t1", 2],
      reverseTagIds: ["t3"],
      otherId: ["o1", "o2"],
      reverseOtherId: "o3",
    },
  },
  inverse_absent: { definition: related },
  inverse_scalar: { definition: related, value: { tagIds: "ignored" } },
  active_empty: {
    definition: related,
    value: { parentId: null, tagIds: [], otherId: null, reverseOtherId: "" },
  },
  last_wins: {
    definition: overlap,
    value: { first: ["old"], last: ["new", "new"] },
  },
  last_clears: {
    definition: overlap,
    value: { first: ["old"], last: [] },
  },
  self_and_escaping: {
    definition: defineCollection({
      ...base,
      relations: { self: relation.hasMany("item", "ids", 'quoted"\\type') },
    }),
    value: { ids: ["i1", 'id"\\\n'] },
  },
  guarded_create: { definition: base, guard: { expected: null } },
  guarded_update: {
    definition: base,
    operation: "update",
    value: { name: "new" },
    guard: { expected: record },
  },
  guarded_refusal: {
    definition: base,
    operation: "update",
    guard: { expected: record, refusal: new Error("policy refused") },
  },
  content: {
    definition: content,
    value: {
      parentId: "p1",
      attachments: [ref("a2"), ref(" a1 ")],
      nested: { refs: [ref("a1")] },
      created: time,
      modified: time,
    },
    assets: [manifest, { ...manifest }],
  },
  content_empty: { definition: content, value: { attachments: [] } },
};

function body(fixture: Fixture): CollectionEventBody<CollectionRecord> {
  const value = { ...record, ...fixture.value };
  const operation = fixture.operation ?? "create";
  const assets = fixture.assets ?? [];
  if (operation === "create") {
    return {
      operation,
      intent: { operation, input: value },
      record: value,
      assets,
    };
  }
  if (operation === "delete") {
    return {
      operation,
      intent: { operation, id: value.id },
      id: value.id,
      record: value,
      assets,
    };
  }
  return {
    operation,
    intent: { operation, id: value.id, set: value, unset: [] },
    id: value.id,
    set: value,
    unset: [],
    record: value,
    assets,
  };
}

const reports = [
  undefined,
  {},
  { exists: true, matches: true },
  { exists: false, matches: false },
  { exists: true, matches: false },
  {
    exists: true,
    matches: true,
    relation: {
      relation: "parent",
      relatedType: "parent",
      relatedId: "missing",
    },
  },
  {
    manifest: [{ ord: 2, id: "a2", foreign: true }, {
      ord: 0,
      id: "a1",
      foreign: false,
    }],
  },
  { manifest: [{ ord: 0, id: "a1", foreign: true }] },
  {
    assets: [{ id: "a2", found: true, state: "failed" }, {
      id: "a1",
      found: false,
      state: null,
    }],
  },
  { assets: [{ id: "a1", found: true, state: "staging" }] },
  { assets: [{ id: "a1", found: true, state: "ready" }] },
];

export function captureProjection(fixture: Fixture) {
  const params: unknown[] = [];
  const statement = composeCollectionProjection(
    { nodes: '"test"."nodes"', edges: '"test"."edges"' },
    fixture.definition,
    body(fixture),
    (value) => `$${params.push(value)}`,
    fixture.guard,
  );
  return {
    ctes: statement.ctes,
    gate: statement.gate,
    effects: statement.effects("proof_source"),
    report: statement.report,
    params,
    failures: reports.map((report) => {
      const failure = statement.failure(report);
      return failure ? { name: failure.name, message: failure.message } : null;
    }),
  };
}

export async function projectionDigest(value: unknown): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Full SQL, ordered parameter values and failure results were captured from
// d154128435af75ee1a017554d7cec9b683cfb629 BEFORE reducer extraction. Do not
// regenerate these when changing projection semantics without explicit review.
const digests: Readonly<Record<string, string>> = {
  "minimal": "853d66d68d7682442f90a15d24645f540ba2160544729b4eca632cc5b64210b7",
  "node": "5e6492dacff26370dc90246f9e3ffbf36256ca4b5ae1125a6771c7c87cc03f4e",
  "update": "30d18f507cd4d939a19088ae78e47a76848e727545647ec97f0aeb8a6d3df66d",
  "delete": "97dfada70e1d87294f922d3dafaa8976faa0c07e69d2d05aa493a25355c4ca24",
  "relations":
    "99254ede7546b98deb63ac74698cacba607200f54655ebb78cf50a81898f60e5",
  "inverse_absent":
    "f63c66e8b054aebfb39ac757bbd4934a51b82d562605e90696f779671e2c6db1",
  "inverse_scalar":
    "cb6a077aa4a43edbb1cc46b29b326eb6e1767306bbc2304b41accf30172a7918",
  "active_empty":
    "0c84655622cf9e5088e9f30e218dbd4b97fb226cec905c41f122000dfb07496a",
  "last_wins":
    "c3deb737cd7bcf1883a0ab1f8a1143e53d603f544de7a636b9b103d3bb837be9",
  "last_clears":
    "3267382c4995991459b0114883462fb385089db6801aed407ab05f8cab0de229",
  "self_and_escaping":
    "22694d7424dfc7b7e8d65d9a7cb2b0234a7661b8d99c944971db1fffee1cdd1e",
  "guarded_create":
    "3a7899208b98e273b613d516887248c8c139db042646946f3bc31ae347348f0a",
  "guarded_update":
    "9d707ef1f4b60c031b0289983de3950e10c329cfc86a5255ebdd306ca5b941e9",
  "guarded_refusal":
    "c5ddeb629e566eba9df05ae2482ffad3b1e39020d098f98b4ab4a71fdd2d1a5f",
  "content": "5f46dc66ca4e8a9c1843de08182a14138be6e19e4d82a8bb736edc58406c96a2",
  "content_empty":
    "d579fae3150a61391f8bb57079d824a6edb9c974581bf2cfe49a333de420bcdc",
};

for (const [name, fixture] of Object.entries(projectionFixtures)) {
  test(`shared ordinary extraction preserves full reducer statement: ${name}`, async () => {
    assert.equal(
      await projectionDigest(captureProjection(fixture)),
      digests[name],
    );
  });
}

test("node statement preserves exact serialized values and nullable timestamp fallbacks", () => {
  const fixture = projectionFixtures.node;
  assert.deepEqual(captureProjection(fixture).params, [
    "tenant",
    "i1",
    "item",
    "0",
    "  Title  \n  Title  ",
    JSON.stringify(body(fixture).record),
    "external",
    "ext",
    time,
    "2026-10-18T00:00:00Z",
  ]);
  const update = captureProjection(projectionFixtures.update);
  assert.deepEqual(update.params.slice(3), [
    "[object Object]",
    null,
    JSON.stringify(body(projectionFixtures.update).record),
    null,
    null,
    null,
    null,
  ]);
  assert.match(
    update.effects[0],
    /created_at = COALESCE\(\$9::timestamptz, created_at\)/,
  );
});

test("relation statement keeps duplicate validation targets and last-wins edges", () => {
  const projection = captureProjection(projectionFixtures.last_wins);
  const [targets, keys, edges, wanted] = projection.params.slice(10);
  assert.deepEqual(JSON.parse(targets as string), [
    { ord: 0, relation: "first", related_type: "tag", related_id: "old" },
    { ord: 1, relation: "last", related_type: "tag", related_id: "new" },
    { ord: 2, relation: "last", related_type: "tag", related_id: "new" },
  ]);
  assert.deepEqual(JSON.parse(keys as string), [
    { edge_type: "shared", related_type: "tag", self_is_source: true },
  ]);
  const id = 'relation:["tenant","shared","i1","new"]';
  assert.deepEqual(JSON.parse(edges as string), [
    { id, source_id: "i1", target_id: "new", edge_type: "shared" },
  ]);
  assert.deepEqual(wanted, [id]);
});

test("reducer keeps timestamp, relation and content failure behavior", () => {
  for (const field of ["createdAt", "updatedAt"]) {
    assert.throws(
      () => captureProjection({ definition: base, value: { [field]: "bad" } }),
      {
        name: "TypeError",
        message:
          `Collection 'item' timestamp field '${field}' must be a valid timestamp.`,
      },
    );
  }
  assert.throws(() =>
    captureProjection({
      definition: related,
      value: { parentId: ["p1", " "] },
    }), {
    name: "TypeError",
    message: "Relation 'parent' foreign key [1] must be non-empty.",
  });
  assert.throws(() =>
    captureProjection({
      definition: content,
      value: { attachments: [ref("a1"), ref("a1", "other")] },
    }), {
    name: "Error",
    message: "Content refs for Asset 'a1' disagree on media type.",
  });
  assert.throws(() =>
    captureProjection({
      definition: content,
      assets: [manifest, { ...manifest, byteLength: 4 }],
    }), {
    name: "Error",
    message: "Asset manifest conflicts with an existing Asset: a1",
  });
});

test("reducer preserves manifest then timestamp then relation then content error order", () => {
  const invalid = {
    created: "invalid",
    parentId: [" "],
    attachments: [ref("a1"), ref("a1", "other")],
  };
  assert.throws(() =>
    captureProjection({
      definition: content,
      value: invalid,
      assets: [manifest, { ...manifest, byteLength: 4 }],
    }), {
    name: "Error",
    message: "Asset manifest conflicts with an existing Asset: a1",
  });
  assert.throws(
    () => captureProjection({ definition: content, value: invalid }),
    {
      name: "TypeError",
      message:
        "Collection 'item' timestamp field 'created' must be a valid timestamp.",
    },
  );
  assert.throws(
    () =>
      captureProjection({
        definition: content,
        value: { ...invalid, created: time },
      }),
    {
      name: "TypeError",
      message: "Relation 'parent' foreign key [0] must be non-empty.",
    },
  );
  assert.throws(
    () =>
      captureProjection({
        definition: content,
        value: { ...invalid, created: time, parentId: "p1" },
      }),
    {
      name: "Error",
      message: "Content refs for Asset 'a1' disagree on media type.",
    },
  );
});
