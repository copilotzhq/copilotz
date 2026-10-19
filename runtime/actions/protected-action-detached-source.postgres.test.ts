import { assertEquals, assertRejects } from "@std/assert";
import {
  authenticatedServerIngressProof,
  type OwnerIngressProof,
  recordOwnerIngress,
} from "../application/ingress/authority.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import {
  createEventStore,
  provisionCopilotzSchema,
  type SqlExecutor,
} from "../events/index.ts";
import {
  createOperationCatalog,
  createOperationCatalogTables,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import {
  assertProtectedActionSourceReplay,
  type ProtectedActionSourceBinding,
  resolveProtectedActionSource,
} from "./protected-action-source.ts";

const postgres = Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL");
const namespace = "scope";
const ingress = {
  kind: "authenticated-server",
  actor: { id: "member" },
} as const;

async function fixture() {
  const db = await createOwnerTestDatabase();
  const schema = "detached_source";
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const catalog = createOperationCatalog(db, schema);
  const tables = createOperationCatalogTables(schema);
  const store = createEventStore({
    session: db,
    schema,
    admitOperationEventSql: (input, param) =>
      catalog.admitEventSql(input, param),
    indexOperationEventSql: (input, param) =>
      catalog.indexEventSql(input, param),
  });
  const run = createSchemaCommandRunner(db, schema);
  const emit = async (
    id: string,
    options: {
      operationId?: string;
      detached?: boolean;
      proof?: OwnerIngressProof;
      namespace?: string;
      data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      causationId?: string;
    } = {},
  ) => {
    const scope = options.namespace ?? namespace;
    const type = "fixture.event";
    const data = options.data ?? { label: id };
    const metadata = options.metadata ?? {};
    const payload = {
      dataRef: {
        eventBodyId: id,
        schemaVersion: 1,
        mediaType: "application/json",
      },
    };
    const result = await store.commitMutation({
      eventId: id,
      draft: {
        namespace: scope,
        type,
        payload,
        metadata,
        ...(options.operationId
          ? { settlementScopeId: options.operationId }
          : {}),
        ...(options.causationId ? { causationId: options.causationId } : {}),
      },
      body: { id, json: data },
      consumers: [{
        consumerId: `fixture:${id}`,
        settlement: options.detached ? "detached" : "inherit",
      }],
      mutate: (context) =>
        recordOwnerIngress(
          context,
          schema,
          { id, namespace: scope, type, payload, metadata },
          data,
          options.proof,
        ),
    });
    return {
      eventId: result.event.id,
      operationId: result.deliveries[0].settlementScopeId,
    };
  };
  const resolve = (
    source: ProtectedActionSourceBinding,
    transaction: SqlExecutor = db,
  ) =>
    resolveProtectedActionSource({
      transaction,
      databaseSchema: schema,
      namespace,
      source,
    });
  const replay = (
    original: ProtectedActionSourceBinding,
    current: ProtectedActionSourceBinding,
    transaction: SqlExecutor = db,
  ) =>
    assertProtectedActionSourceReplay({
      transaction,
      databaseSchema: schema,
      namespace,
      original,
      current,
    });
  return { db, schema, tables, run, emit, resolve, replay };
}

Deno.test({
  name:
    "PostgreSQL detached owner indexes preserve original ingress across two levels and replay",
  ignore: !postgres,
  async fn() {
    const f = await fixture();
    try {
      const root = await f.emit("root", {
        proof: authenticatedServerIngressProof(ingress.actor),
      });
      const first = await f.emit("first", {
        operationId: root.operationId,
        detached: true,
      });
      const second = await f.emit("second", {
        operationId: first.operationId,
        detached: true,
      });
      const current = await f.emit("current", {
        operationId: second.operationId,
      });
      // Use the real event-store/catalog CTEs: detached roots have no parent,
      // and each root event has exactly one index, in the emitting operation.
      for (const [source, parent] of [[first, root], [second, first]]) {
        assertEquals(
          (await f.db.query(
            `SELECT root_event_id,visibility,parent_operation_id,parent_action_run_id FROM ${f.tables.operations} WHERE operation_id=$1`,
            [source.operationId],
          )).rows,
          [{
            root_event_id: source.eventId,
            visibility: "internal",
            parent_operation_id: null,
            parent_action_run_id: null,
          }],
        );
        assertEquals(
          (await f.db.query(
            `SELECT namespace,operation_id FROM ${f.tables.operationEvents} WHERE event_id=$1`,
            [source.eventId],
          )).rows,
          [{ namespace, operation_id: parent.operationId }],
        );
      }
      const resolved = await f.resolve(current);
      assertEquals(resolved.ingress, ingress);
      assertEquals(resolved.data, { label: "root" });
      assertEquals(resolved.ancestors.map((entry) => entry.event.id), [
        "root",
        "first",
        "second",
        "current",
      ]);
      assertEquals(
        resolved.ancestors.map((entry) => entry.ingress),
        [ingress, undefined, undefined, undefined],
      );
      await f.replay(root, first);
      await f.replay(root, current);
      await f.replay(first, current);
      await f.replay(second, current);
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name: "PostgreSQL parent-only source ancestry and replay remain unchanged",
  ignore: !postgres,
  async fn() {
    const f = await fixture();
    try {
      const root = await f.emit("root", {
        proof: authenticatedServerIngressProof(ingress.actor),
      });
      const child = await f.emit("child");
      const grandchild = await f.emit("grandchild");
      for (const [source, parent] of [[child, root], [grandchild, child]]) {
        await f.db.query(
          `UPDATE ${f.tables.operations} SET parent_operation_id=$2,parent_action_run_id=$3 WHERE operation_id=$1`,
          [source.operationId, parent.operationId, `action:${source.eventId}`],
        );
      }
      const current = await f.emit("current", {
        operationId: grandchild.operationId,
      });
      const resolved = await f.resolve(current);
      assertEquals(resolved.ingress, ingress);
      assertEquals(resolved.ancestors.map((entry) => entry.event.id), [
        "root",
        "child",
        "grandchild",
        "current",
      ]);
      await f.replay(root, current);
      await f.replay(child, current);
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL detached ancestry never promotes spoofed payload, metadata or causation to ingress",
  ignore: !postgres,
  async fn() {
    const f = await fixture();
    try {
      const trusted = await f.emit("trusted", {
        proof: authenticatedServerIngressProof(ingress.actor),
      });
      const spoofed = {
        ingress,
        actor: ingress.actor,
        hostIngress: true,
        sourceEventId: trusted.eventId,
        parentOperationId: trusted.operationId,
        serverScope: { actor: ingress.actor },
      };
      const root = await f.emit("unclassified", {
        data: spoofed,
        metadata: spoofed,
        causationId: trusted.eventId,
      });
      const detached = await f.emit("detached", {
        operationId: root.operationId,
        detached: true,
        data: spoofed,
        metadata: spoofed,
        causationId: trusted.eventId,
      });
      const resolved = await f.resolve(detached);
      assertEquals(resolved.event.id, root.eventId);
      assertEquals(resolved.data, spoofed);
      assertEquals(resolved.ingress, undefined);
      assertEquals(resolved.ancestors.map((entry) => entry.ingress), [
        undefined,
        undefined,
      ]);
      await f.replay(root, detached);
      await assertRejects(() => f.replay(trusted, detached), Error, "binding");
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL detached replay refuses unrelated operations and original or current event substitution",
  ignore: !postgres,
  async fn() {
    const f = await fixture();
    try {
      const root = await f.emit("root");
      const original = await f.emit("original", {
        operationId: root.operationId,
      });
      const detached = await f.emit("detached", {
        operationId: root.operationId,
        detached: true,
      });
      const current = await f.emit("current", {
        operationId: detached.operationId,
      });
      const unrelated = await f.emit("unrelated");
      await f.replay(original, current);
      for (
        const [before, after] of [
          [unrelated, current],
          [original, unrelated],
          [{ ...original, eventId: unrelated.eventId }, current],
          [original, { ...current, eventId: unrelated.eventId }],
          [original, { ...current, eventId: original.eventId }],
          [{ ...original, eventId: current.eventId }, current],
          [{ eventId: original.eventId }, current],
        ]
      ) {
        await assertRejects(() => f.replay(before, after), Error, "binding");
      }
      // An ordinary indexed event is not enough: retained delivery membership
      // must still bind both non-root source events to their operation.
      for (const binding of [original, current]) {
        const rollback = "rollback membership fixture";
        await assertRejects(
          () =>
            f.run("fixture.membership", {}, async (_, { transaction }) => {
              await transaction.query(
                `DELETE FROM "${f.schema}".event_deliveries WHERE event_id=$1`,
                [binding.eventId],
              );
              await assertRejects(
                () => f.replay(original, current, transaction),
                Error,
                "binding",
              );
              throw new Error(rollback);
            }),
          Error,
          rollback,
        );
      }
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL detached source and replay fail closed on missing, mismatched, cross-namespace or cyclic ancestry",
  ignore: !postgres,
  async fn(t) {
    const f = await fixture();
    try {
      const root = await f.emit("root");
      const first = await f.emit("first", {
        operationId: root.operationId,
        detached: true,
      });
      const second = await f.emit("second", {
        operationId: first.operationId,
        detached: true,
      });
      const foreign = await f.emit("foreign", { namespace: "other" });
      const corruptions: [string, string, unknown[], string][] = [
        [
          "empty indexed operation",
          `UPDATE ${f.tables.operationEvents} SET operation_id='' WHERE event_id=$1`,
          [first.eventId],
          "unavailable",
        ],
        [
          "missing root index",
          `DELETE FROM ${f.tables.operationEvents} WHERE event_id=$1`,
          [first.eventId],
          "unavailable",
        ],
        [
          "index namespace mismatch",
          `UPDATE ${f.tables.operationEvents} SET namespace='other' WHERE event_id=$1`,
          [first.eventId],
          "unavailable",
        ],
        [
          "self-indexed internal root",
          `UPDATE ${f.tables.operationEvents} SET operation_id=$2 WHERE event_id=$1`,
          [first.eventId, first.operationId],
          "unavailable",
        ],
        [
          "missing indexed operation",
          `UPDATE ${f.tables.operationEvents} SET operation_id='missing' WHERE event_id=$1`,
          [first.eventId],
          "unavailable",
        ],
        [
          "cross-namespace indexed operation",
          `UPDATE ${f.tables.operationEvents} SET operation_id=$2 WHERE event_id=$1`,
          [first.eventId, foreign.operationId],
          "unavailable",
        ],
        [
          "cross-namespace retained root event",
          `UPDATE ${f.tables.operations} SET root_event_id=$2 WHERE operation_id=$1`,
          [first.operationId, foreign.eventId],
          "unavailable",
        ],
        [
          "detached index cycle",
          `UPDATE ${f.tables.operationEvents} SET operation_id=$2 WHERE event_id=$1`,
          [first.eventId, second.operationId],
          "invalid",
        ],
        [
          "partial explicit parent",
          `UPDATE ${f.tables.operations} SET parent_operation_id=$2 WHERE operation_id=$1`,
          [first.operationId, root.operationId],
          "unavailable",
        ],
        [
          "explicit parent cycle",
          `UPDATE ${f.tables.operations} SET parent_operation_id=$1,parent_action_run_id='action' WHERE operation_id=$1`,
          [first.operationId],
          "invalid",
        ],
        [
          "cross-namespace explicit parent",
          `UPDATE ${f.tables.operations} SET parent_operation_id=$2,parent_action_run_id='action' WHERE operation_id=$1`,
          [first.operationId, foreign.operationId],
          "unavailable",
        ],
      ];
      for (const [name, sql, params, message] of corruptions) {
        await t.step(name, async () => {
          const rollback = "rollback corrupt fixture";
          await assertRejects(
            () =>
              f.run("fixture.corrupt", {}, async (_, { transaction }) => {
                await transaction.query(sql, params);
                await assertRejects(
                  () => f.resolve(second, transaction),
                  Error,
                  message,
                );
                await assertRejects(
                  () => f.replay(root, second, transaction),
                  Error,
                  message,
                );
                throw new Error(rollback);
              }),
            Error,
            rollback,
          );
          await f.replay(root, second);
        });
      }
    } finally {
      await f.db.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL detached source and replay retain the 64-operation depth bound",
  ignore: !postgres,
  async fn() {
    const f = await fixture();
    try {
      const root = await f.emit("root");
      let current = root;
      for (let i = 1; i < 64; i++) {
        current = await f.emit(`detached-${i}`, {
          operationId: current.operationId,
          detached: true,
        });
      }
      assertEquals((await f.resolve(current)).ancestors.length, 64);
      await f.replay(root, current);
      current = await f.emit("too-deep", {
        operationId: current.operationId,
        detached: true,
      });
      await assertRejects(
        () => f.resolve(current),
        Error,
        "ancestry is invalid",
      );
      await assertRejects(
        () => f.replay(root, current),
        Error,
        "ancestry is invalid",
      );
    } finally {
      await f.db.close();
    }
  },
});
