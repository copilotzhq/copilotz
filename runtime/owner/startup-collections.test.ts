import { provisionOwnerContentCatalog } from "../streams/owner-catalog-schema.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection } from "../collections/definition.ts";
import { provisionCollectionIndexes } from "../collections/indexes.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerOperationCatalogCore } from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionOwnerAssignments } from "./assignments.ts";
import { createOwnerCommandBoundary, type OwnerCaller } from "./boundary.ts";
import {
  createOwnerCollectionCommand,
  type OwnerCollectionScope,
} from "./collections.ts";
import { ownerReconciliationAlarm } from "./reconciliation.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createOwnerOperationSettlement } from "./settlement.ts";
import { captureOwnerGraphCollections } from "./startup-graph.ts";
import {
  createOwnerStartupProof,
  OWNER_STARTUP_PROOF,
  OWNER_STARTUP_REPAIR,
  ownerStartupRepairKey,
} from "./startup.ts";

function definitions() {
  const fields = {
    id: { type: "string" },
    namespace: { type: "string" },
    title: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  } as const;
  return {
    folders: defineCollection({
      name: "restart_folder",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: fields,
        required: ["id", "namespace", "title", "createdAt", "updatedAt"],
      } as const,
    }),
    notes: defineCollection({
      name: "restart_note",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...fields,
          folderId: { type: "string" },
          externalId: { type: "string" },
        },
        required: [
          "id",
          "namespace",
          "title",
          "createdAt",
          "updatedAt",
          "folderId",
          "externalId",
        ],
      } as const,
      search: { enabled: true, fields: ["title"] },
      identity: { sourceType: "external", sourceField: "externalId" },
      indexes: [{ fields: "externalId", unique: true }],
      relations: {
        folder: {
          type: "belongsTo",
          collection: "restart_folder",
          foreignKey: "folderId",
        },
      },
    }),
  };
}
type Options = {
  namespaces?: readonly string[];
  maxItems?: number;
  maxBytes?: number;
};
async function fixture(
  options: Options = { namespaces: ["space"] },
  rooted = true,
) {
  const collections = definitions();
  const registry = createPluginRegistry({ collections });
  const capturedOptions = {
    ownerId: "owner",
    schema: "public",
    registry,
    ...options,
    authorizeControl(_tx: unknown, caller: OwnerCaller) {
      return caller.principal.kind === "owner-control";
    },
  };
  const startup = createOwnerStartupProof(capturedOptions);
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  await provisionCopilotzSchema(db, "public");
  await provisionOwnerContentCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await provisionOwnerAssignments(db, "public");
  await provisionCollectionIndexes(db, "public", Object.values(collections));
  const catalog = createOwnerOperationCatalogCore(db, "public");
  const executor: DeliveryExecutor = {
    ownership: "injected_dispatcher",
    workload: "startup-collection-fixture",
    workloads: {},
    scheduleDelivery() {
      throw new Error("This fixture has no registered consumers.");
    },
    dispatchWork: () => Promise.reject(new Error("No business dispatch.")),
    dispatchDelivery: () => Promise.reject(new Error("No business dispatch.")),
    dispatchRecoverable: () =>
      Promise.reject(new Error("No recovery dispatch.")),
    settleOutputs: () => Promise.resolve(),
    awaitScopeProgress: () => Promise.resolve(false),
    shutdown: () => Promise.resolve(),
  };
  const scopes = new WeakMap<SqlExecutor, OwnerCollectionScope>();
  const collection = createOwnerCollectionCommand({
    session: db,
    schema: "public",
    registry,
    collections,
    catalog,
    executor,
    scope(context) {
      const current = scopes.get(context.tx);
      if (!current) throw new Error("Missing fixture scope.");
      return current;
    },
  });
  const settlement = createOwnerOperationSettlement({
    ownerId: "owner",
    schema: "public",
    session: db,
    catalog,
    authorizeControl: (_tx, caller) =>
      caller.principal.kind === "owner-control",
    selectDrains: () => [],
    authorizeDrain: () => false,
    drain: () => Promise.resolve(false),
    wake() {},
  });
  let epoch = 1;
  function caller(): OwnerCaller {
    return {
      principal: {
        kind: "owner-control",
        ownerId: "owner",
        epoch,
        holderId: `holder-${epoch}`,
      },
      ownerEpoch: epoch,
    };
  }
  function boundary() {
    return createOwnerCommandBoundary({
      ownerId: "owner",
      holderId: `holder-${epoch}`,
      schema: "public",
      session: db,
      handlers: {
        async collections(intent, context) {
          // As in actual Action/Processor invocation, Collection writes inherit
          // an operation created by a genuine owner EventStore append. No scope
          // row or event association is inserted after the mutation.
          if (rooted) {
            const root = await createEventStore({
              session: db,
              schema: "public",
              ownerCommit: context.ownerCommit,
              admitOperationEventSql: catalog.admitEventSql,
              indexOperationEvent: catalog.indexEvent,
              indexOperationEventSql: catalog.indexEventSql,
            }).commitMutation({
              transaction: context.tx,
              draft: {
                namespace: "space",
                type: "fixture.root",
                payload: {},
                deduplicationId: `root:${context.command.key}`,
              },
              consumers: [],
            });
            scopes.set(context.tx, {
              namespace: "space",
              identity: {
                causationId: root.event.id,
                correlationId: root.event.correlationId,
                settlementScopeId: root.settlementScopeId,
              },
            });
          } else scopes.set(context.tx, { namespace: "space" });
          try {
            return await collection(intent, context);
          } finally {
            scopes.delete(context.tx);
          }
        },
        ...startup.handlers,
        ...settlement.handlers,
      },
      projections: { ...startup.projections, ...settlement.projections },
      authenticateReceipt() {
        throw new Error("No ambient receipt authority.");
      },
      async authorize(tx, caller, command, time) {
        if (command.kind.startsWith("startup.")) {
          return await startup.authorize(tx, caller, command, time);
        }
        if (command.kind.startsWith("operation.")) {
          return await settlement
            .authorize(tx, caller, command, time);
        }
        assert.equal(caller.principal.kind, "owner-control");
        assert.equal(command.kind, "collections");
      },
    });
  }
  let current = boundary();
  await current.acquire(0);
  const repair = (occurrence: string = crypto.randomUUID()) =>
    current.execute(caller(), {
      kind: OWNER_STARTUP_REPAIR,
      domain: "occurrence",
      key: ownerStartupRepairKey("owner", epoch, occurrence),
      intent: { occurrence },
    });
  const proof = () => current.project(caller(), OWNER_STARTUP_PROOF, null);
  return {
    db,
    collections,
    capturedOptions,
    registry,
    repair,
    proof,
    async write(title = "search text") {
      return await current.execute(caller(), {
        kind: "collections",
        domain: "logical",
        key: "create-graph",
        intent: {
          operations: [
            {
              collection: "folders",
              operation: "create",
              input: { id: "folder", title: "Folder" },
            },
            {
              collection: "notes",
              operation: "create",
              input: {
                id: "note",
                title,
                folderId: "folder",
                externalId: "external-note",
              },
            },
          ],
        },
      });
    },
    async takeover() {
      current.stop();
      const prior = epoch++;
      current = boundary();
      await current.acquire(prior);
    },
    async settleAndProve() {
      for (let pass = 0; pass < 4; pass++) {
        const result = (await repair()).result as {
          blockers: unknown[];
          settlements: { namespace: string; operationId: string }[];
        };
        assert.deepEqual(result.blockers, []);
        if (!result.settlements.length) return await proof();
        for (const target of result.settlements) {
          await settlement.run({
            boundary: current,
            caller: caller(),
            target,
            occurrence: crypto.randomUUID(),
          });
        }
      }
      throw new Error("Fixture settlement did not converge.");
    },
    async close() {
      current.stop();
      await db.close();
    },
  };
}
const stableGraphAlarm = ownerReconciliationAlarm("owner", {
  kind: "blocker",
  namespace: null,
  id: "startup.graph",
});

test("startup validates actual Collection projection, declared edges and captured namespace coverage", async () => {
  const namespaces = ["space"];
  const f = await fixture({ namespaces });
  try {
    namespaces[0] = "changed";
    await f.write();
    await f.takeover();
    const proof = await f.settleAndProve();
    assert.equal((proof as { epoch: number }).epoch, 2);
    const rows = await f.db.query<{ value: Record<string, unknown> }>(
      "SELECT to_jsonb(nodes) AS value FROM nodes ORDER BY id",
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(typeof rows.rows[0].value.created_at, "string");
    assert.equal(rows.rows[1].value.content, "search text");
    assert.equal(rows.rows[1].value.source_id, "external-note");
    assert.equal((await f.db.query("SELECT 1 FROM edges")).rows.length, 1);
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("startup requires explicit matching namespace coverage for retained Collection rows", async () => {
  for (
    const options of [{}, { namespaces: ["other"] }, {
      namespaces: [],
    }] as Options[]
  ) {
    const f = await fixture(options);
    try {
      await f.write();
      await f.takeover();
      const result = (await f.repair()).result as {
        blockers: { id: string }[];
      };
      assert.ok(
        result.blockers.some((row) =>
          row.id ===
            (options.namespaces === undefined
              ? "startup.nodes"
              : "startup.graph")
        ),
      );
      await assert.rejects(f.proof(), /unresolved/);
    } finally {
      await f.close();
    }
  }
});

test("startup graph incompatibility uses one stable alarm and replay cannot skip current repair or exact reproof", async () => {
  const f = await fixture();
  try {
    await f.write();
    await f.takeover();
    await f.settleAndProve();
    const oldAlarm = ownerReconciliationAlarm("owner", {
      kind: "blocker",
      namespace: null,
      id: "startup.nodes",
    });
    await f.db.query(
      "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,now())",
      [oldAlarm],
    );
    await assert.rejects(f.proof(), /coverage|unresolved/);
    await f.repair("clear-old");
    await f.proof();
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
      0,
    );
    await f.db.query("UPDATE nodes SET content='corrupt' WHERE id='note'");
    const bad = (await f.repair("bad")).result as {
      blockers: { id: string; reason: string }[];
    };
    assert.deepEqual(bad.blockers, [{
      kind: "blocker",
      namespace: null,
      id: "startup.graph",
      reason: "graph_current_state_incompatible",
    }]);
    assert.equal(
      (await f.db.query("SELECT name FROM owner_alarms")).rows[0].name,
      stableGraphAlarm,
    );
    await assert.rejects(f.proof(), /unresolved/);
    await f.db.query("UPDATE nodes SET content='search text' WHERE id='note'");
    await assert.rejects(f.repair("bad"), /historical startup receipt/);
    await assert.rejects(f.proof(), /coverage|unresolved/);
    await f.repair("fixed");
    await f.proof();
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("startup preserves microseconds and blocks inconsistent identity, namespace, search and declared edges", async () => {
  const f = await fixture();
  try {
    await f.write();
    await f.takeover();
    await f.settleAndProve();
    const mutations = [
      [
        "UPDATE nodes SET created_at=created_at+interval '1 microsecond' WHERE id='note'",
        "UPDATE nodes SET created_at=(data->>'createdAt')::timestamptz WHERE id='note'",
      ],
      [
        "UPDATE nodes SET source_id='wrong' WHERE id='note'",
        "UPDATE nodes SET source_id='external-note' WHERE id='note'",
      ],
      [
        "UPDATE nodes SET data=jsonb_set(data,'{namespace}','\"other\"') WHERE id='note'",
        "UPDATE nodes SET data=jsonb_set(data,'{namespace}','\"space\"') WHERE id='note'",
      ],
      ["UPDATE edges SET weight=2", "UPDATE edges SET weight=1"],
    ];
    for (const [mutate, restore] of mutations) {
      await f.db.query(mutate);
      const result = (await f.repair()).result as {
        blockers: { id: string }[];
      };
      assert.ok(result.blockers.some((row) => row.id === "startup.graph"));
      await assert.rejects(f.proof(), /unresolved/);
      await f.db.query(restore);
      await f.repair();
      await f.proof();
    }
    const edge = (await f.db.query<{ value: Record<string, unknown> }>(
      "SELECT to_jsonb(edges) AS value FROM edges",
    )).rows[0].value;
    await f.db.query("DELETE FROM edges");
    const missing = (await f.repair()).result as { blockers: { id: string }[] };
    assert.ok(missing.blockers.some((row) => row.id === "startup.graph"));
    await f.db.query(
      "INSERT INTO edges SELECT * FROM jsonb_populate_record(NULL::edges,$1::jsonb)",
      [JSON.stringify(edge)],
    );
    await f.repair();
    await f.proof();
  } finally {
    await f.close();
  }
});

test("startup graph proof validates current physical and declared indexes without provisioning", async () => {
  const f = await fixture();
  try {
    await f.write();
    await f.takeover();
    await f.settleAndProve();
    const index = (await f.db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'collection_idx_%'",
    )).rows[0].indexname;
    await f.db.query(`DROP INDEX "${index}"`);
    await assert.rejects(f.repair(), /Collection indexes missing/);
    assert.equal(
      (await f.db.query("SELECT 1 FROM pg_indexes WHERE indexname=$1", [index]))
        .rows.length,
      0,
    );
    await provisionCollectionIndexes(
      f.db,
      "public",
      Object.values(f.collections),
    );
    await f.proof();
    await f.db.query("ALTER TABLE nodes ALTER COLUMN created_at DROP DEFAULT");
    await assert.rejects(f.proof(), /graph schema is incompatible/);
  } finally {
    await f.close();
  }
});

test("startup charges captured graph configuration and raw plus derived evidence to shared budgets", async () => {
  const registry = createPluginRegistry({ collections: definitions() });
  const construct = (extra: Options) =>
    createOwnerStartupProof({
      ownerId: "owner",
      schema: "public",
      registry,
      authorizeControl: () => true,
      ...extra,
    });
  assert.throws(
    () => construct({ namespaces: ["space"], maxItems: 1 }),
    /configuration/,
  );
  assert.throws(
    () => construct({ namespaces: ["space"], maxBytes: 1024 }),
    /configuration/,
  );
  for (const namespaces of [["space", "space"], [" space"], null, [123]]) {
    assert.throws(
      () => construct({ namespaces: namespaces as never }),
      /namespace|identity/,
    );
  }
  let reads = 0;
  const getter = [] as string[];
  Object.defineProperty(getter, "0", {
    enumerable: true,
    get() {
      reads++;
      return "space";
    },
  });
  assert.throws(() => construct({ namespaces: getter }), /namespace/);
  assert.equal(reads, 0);
  // Leave capacity for exactly the two raw nodes and their one edge, so the
  // graph helper must use the same exhausted budget for its derived descriptors.
  const configuration: unknown[] = [{
    namespaces: ["space"],
    collections: captureOwnerGraphCollections(
      Object.values(registry.collections),
    ),
  }];
  let configurationItems = 0;
  while (configuration.length) {
    const value = configuration.pop();
    configurationItems++;
    if (value !== null && typeof value === "object") {
      configuration.push(...Object.values(value));
    }
  }
  const derived = await fixture({
    namespaces: ["space"],
    maxItems: configurationItems + 3,
  });
  try {
    await derived.write();
    await derived.takeover();
    await assert.rejects(derived.repair(), (error: unknown) => {
      assert.equal(
        (error as { code: string }).code,
        "owner_graph_inventory_incomplete",
      );
      return true;
    });
    assert.equal(
      (await derived.db.query("SELECT 1 FROM owner_alarms")).rows.length,
      0,
    );
  } finally {
    await derived.close();
  }
  const f = await fixture({ namespaces: ["space"], maxBytes: 16000 });
  try {
    await f.write("x".repeat(4000));
    await f.takeover();
    await assert.rejects(f.repair(), /budget|incomplete/);
    assert.equal(
      (await f.db.query("SELECT 1 FROM owner_alarms")).rows.length,
      0,
      "overflow cannot publish a partial plan",
    );
  } finally {
    await f.close();
  }
});

test("startup graph-empty omission cannot discharge a retained explicit graph proof obligation", async () => {
  const f = await fixture({});
  try {
    await f.takeover();
    await f.proof();
    await f.db.query(
      "INSERT INTO owner_alarms(owner,name,due_at) VALUES('owner',$1,now())",
      [stableGraphAlarm],
    );
    const result = (await f.repair()).result as { blockers: { id: string }[] };
    assert.ok(result.blockers.some((row) => row.id === "startup.graph"));
    await assert.rejects(f.proof(), /coverage|unresolved/);
    assert.equal(
      (await f.db.query("SELECT name FROM owner_alarms")).rows[0].name,
      stableGraphAlarm,
    );
  } finally {
    await f.close();
  }
});

test("startup refuses direct unscoped Collection history without inventing catalog membership", async () => {
  const f = await fixture({ namespaces: ["space"] }, false);
  try {
    await f.write();
    assert.equal(
      (await f.db.query("SELECT 1 FROM events WHERE owner_id='owner'")).rows
        .length,
      2,
    );
    assert.equal(
      (await f.db.query("SELECT 1 FROM copilotz_operation_events")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("SELECT 1 FROM copilotz_operations")).rows.length,
      0,
    );
    await f.takeover();
    const result = (await f.repair()).result as {
      blockers: { reason: string }[];
    };
    assert.equal(
      result.blockers.filter((row) =>
        row.reason === "event_owner_or_catalog_link_invalid"
      ).length,
      2,
    );
    await assert.rejects(f.proof(), /coverage|unresolved/);
    assert.equal(
      (await f.db.query("SELECT 1 FROM copilotz_operation_events")).rows.length,
      0,
    );
  } finally {
    await f.close();
  }
});
