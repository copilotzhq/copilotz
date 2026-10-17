import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection, relation } from "./definition.ts";
import {
  describeCollectionOrdinaryProjection,
  edgeId,
  identitySource,
  searchContent,
} from "./ordinary-projection.ts";
import {
  edgeId as currentEdgeId,
  identitySource as currentIdentitySource,
  searchContent as currentSearchContent,
} from "./reducer.ts";

const time = "2026-10-17T00:00:00.000Z";
const definition = defineCollection({
  name: "item",
  schema: { type: "object" },
  search: { enabled: true, fields: ["title", "body", "skip"] },
  identity: { sourceType: "external", sourceField: "externalId" },
  timestamps: { createdAt: "created", updatedAt: "modified" },
});

test("draft pure node helpers match currently exported reducer helpers", () => {
  for (
    const value of [{}, { title: " title ", body: "text", skip: " " }, {
      externalId: " external ",
    }, { externalId: 2, title: 4 }]
  ) {
    assert.deepEqual(
      identitySource(definition, value),
      currentIdentitySource(definition, value),
    );
    assert.equal(
      searchContent(definition, value),
      currentSearchContent(definition, value),
    );
  }
  assert.equal(
    edgeId("tenant", "relation", "left", "right"),
    currentEdgeId("tenant", "relation", "left", "right"),
  );
  const data = {
    id: "i1",
    namespace: "tenant",
    title: "A",
    externalId: " ext ",
    created: time,
    modified: time,
  };
  assert.deepEqual(
    describeCollectionOrdinaryProjection(definition, data).node,
    {
      name: "i1",
      content: "A",
      data: JSON.stringify(data),
      sourceType: "external",
      sourceId: "ext",
      createdAt: time,
      updatedAt: time,
    },
  );
});

test("draft descriptor retains current inverse skip and last-wins derivation", () => {
  const declared = defineCollection({
    ...definition,
    relations: {
      inverse: relation.hasMany("other", "absent", "inverse"),
      hasOne: relation.hasOne("other", "absentOne", "absent"),
      first: relation.hasMany("other", "first", "shared"),
      last: relation.hasMany("other", "last", "shared"),
      parent: relation.belongsTo("other", "parents"),
      reversed: relation.hasOne("other", "reversed", "back", "child-to-parent"),
    },
  });
  const result = describeCollectionOrdinaryProjection(declared, {
    id: "i1",
    namespace: "tenant",
    first: ["old"],
    last: ["new"],
    parents: ["first-parent", "ignored-parent"],
    reversed: "r",
  });
  assert.equal(result.keys.length, 3);
  assert.deepEqual(
    result.edges.map((
      { source_id, target_id, edge_type },
    ) => [source_id, target_id, edge_type]),
    [
      ["i1", "new", "shared"],
      ["first-parent", "i1", "has_item"],
      ["r", "i1", "back"],
    ],
  );
  assert.deepEqual(result.targets.map(({ related_id }) => related_id), [
    "old",
    "new",
    "first-parent",
    "r",
  ]);
  assert.equal(result.node.createdAt, null);
  assert.equal(result.node.updatedAt, null);
});
