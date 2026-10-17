import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import { defineCollection } from "../collections/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import { createOwnerCommandBoundary, type OwnerJson } from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createOwnerCollectionCommand } from "./collections.ts";

const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      title: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "title", "createdAt", "updatedAt"],
  } as const,
});

async function fixture() {
  const db = await createTestDatabase();
  for (const statement of createCoreSchemaStatements("public")) {
    await db.query(statement);
  }
  await provisionOwnerCommandSchema(db, "public");
  await db.query(
    "CREATE TABLE current_grants (worker_id TEXT PRIMARY KEY, allowed BOOLEAN NOT NULL, invocation TEXT NOT NULL, namespace TEXT NOT NULL)",
  );
  await db.query(
    "INSERT INTO current_grants VALUES ('worker', TRUE, 'invocation', 'authorized-space')",
  );
  let observedResolve!: () => void;
  const observed = new Promise<void>((resolve) => observedResolve = resolve);
  const observations: { records: number; receipts: number; seq: unknown }[] =
    [];
  const processor = defineProcessor({
    id: "owner.notes.observe",
    on: [{ eventType: "note.created" }],
    async handle(event) {
      observations.push({
        records:
          (await db.query("SELECT id FROM nodes WHERE type = 'note'")).rows
            .length,
        receipts:
          (await db.query("SELECT key FROM owner_receipts")).rows.length,
        seq: event.durable ? event.seq : undefined,
      });
      observedResolve();
    },
  });
  const registry = createPluginRegistry({
    plugins: [
      definePlugin({
        id: "owner-test",
        version: "1",
        collections: { notes },
        processors: { observe: processor },
      }),
    ],
  });
  const store = createEventStore({ session: db });
  const executor = createDeliveryExecutor({
    store,
    registry,
    createContext: createTestProcessorContext,
    workerId: "owner-fixture-executor",
  });
  const command = createOwnerCollectionCommand({
    session: db,
    schema: "public",
    registry,
    collections: { notes },
    executor,
    scope: (context) => ({ namespace: String(context.caller.namespace) }),
  });
  const boundary = createOwnerCommandBoundary({
    session: db,
    schema: "public",
    ownerId: "tenant",
    holderId: "holder",
    handlers: { collections: command },
    async authorize(tx, caller, command) {
      const grant = await tx.query(
        "SELECT allowed, invocation, namespace FROM current_grants WHERE worker_id = $1",
        [
          caller.principal.kind === "worker"
            ? caller.principal.workerId
            : undefined,
        ],
      );
      if (
        grant.rows[0]?.invocation !== caller.invocation ||
        grant.rows[0]?.namespace !== caller.namespace ||
        !command.key.startsWith(`${caller.invocation}:`)
      ) {
        throw new Error("invocation binding refused");
      }
      if (grant.rows[0]?.allowed !== true) {
        throw new Error("current grant refused");
      }
    },
    authenticateReceipt(_tx, caller) {
      if (
        (caller.principal.kind === "worker"
          ? caller.principal.workerId
          : undefined) !== "worker"
      ) throw new Error("unauthenticated");
    },
  });
  const epoch = await boundary.acquire(0);
  const caller = {
    principal: { kind: "worker" as const, workerId: "worker" },
    ownerEpoch: epoch,
    invocation: "invocation",
    namespace: "authorized-space",
  };
  const create = (id: string) => ({
    collection: "notes",
    operation: "create",
    input: { id, title: id },
  });
  const execute = (key: string, operations: OwnerJson[]) =>
    boundary.execute(caller, {
      kind: "collections",
      domain: "logical",
      key: `invocation:${key}`,
      intent: { operations },
    });
  return {
    db,
    executor,
    boundary,
    caller,
    observations,
    observed,
    create,
    execute,
    async close() {
      boundary.stop();
      await executor.shutdown();
      await db.close();
    },
  };
}

test("owner Collection command commits actual rows, reference receipt and real Processor after durability", async () => {
  const f = await fixture();
  try {
    const operations = [f.create("a"), f.create("b")];
    const first = await f.execute("one", operations);
    assert.equal(first.status, "committed");
    assert.deepEqual((first.result as { recordIds: string[] }).recordIds, [
      "a",
      "b",
    ]);
    assert.equal(JSON.stringify(first.result).includes("title"), false);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        f.observed,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Processor did not run")),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(f.observations[0].records, 2);
    assert.equal(f.observations[0].receipts, 1);
    assert.ok(f.observations[0].seq);
    const duplicate = await f.execute("one", operations);
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.result, first.result);
    assert.deepEqual(
      (await f.db.query("SELECT seq FROM events ORDER BY seq")).rows.map(
        (row) => String(row.seq),
      ),
      ["1", "2"],
    );
    await assert.rejects(
      f.execute("one", [f.create("changed")]),
      /intent|conflict|reus/i,
    );
    const noop = await f.execute("noop", []);
    assert.deepEqual((noop.result as { eventIds: string[] }).eventIds, []);
    assert.equal(
      String(
        (await f.db.query("SELECT last_seq FROM owner_epochs")).rows[0]
          .last_seq,
      ),
      "2",
    );
    await assert.rejects(
      f.boundary.execute({
        ...f.caller,
        namespace: "different-authorized-space",
      }, {
        kind: "collections",
        domain: "logical",
        key: "invocation:one",
        intent: { operations },
      }),
      /invocation binding refused/,
    );
    await assert.rejects(
      f.boundary.execute({ ...f.caller, invocation: "other-invocation" }, {
        kind: "collections",
        domain: "logical",
        key: "invocation:one",
        intent: { operations },
      }),
      /invocation binding refused/,
    );
    await f.db.query("UPDATE current_grants SET allowed = FALSE");
    await assert.rejects(f.execute("one", operations), /grant refused/);
    assert.ok(
      await f.boundary.readReceipt({ ...f.caller, ownerEpoch: 0 }, {
        domain: "logical",
        key: "invocation:one",
      }),
    );
  } finally {
    await f.close();
  }
});

test("owner Collection failed command rolls back rows and sequence without losing siblings", async () => {
  const f = await fixture();
  try {
    const commands = await Promise.allSettled([
      f.execute("first", [f.create("a")]),
      f.execute("failed", [f.create("discarded"), {
        collection: "notes",
        operation: "create",
        input: { id: "invalid" },
      }]),
      f.execute("last", [f.create("b")]),
    ]);
    assert.deepEqual(commands.map((result) => result.status), [
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    assert.deepEqual(
      (await f.db.query("SELECT id FROM nodes WHERE type = 'note' ORDER BY id"))
        .rows.map((row) => row.id),
      ["a", "b"],
    );
    assert.deepEqual(
      (await f.db.query("SELECT seq FROM events ORDER BY seq")).rows.map(
        (row) => String(row.seq),
      ),
      ["1", "2"],
    );
    assert.equal(
      (await f.db.query("SELECT key FROM owner_receipts")).rows.length,
      2,
    );
    await assert.rejects(
      f.execute("unsupported", [{
        collection: "notes",
        operation: "snapshot",
        input: {},
      }]),
      /Unsupported/,
    );
    await assert.rejects(
      f.boundary.execute(f.caller, {
        kind: "collections",
        domain: "logical",
        key: "invocation:forged",
        intent: { operations: [], namespace: "other" },
      }),
      /operations only/,
    );
  } finally {
    await f.close();
  }
});

test("Collection event identities do not depend on the executing worker", async () => {
  const outcomes: unknown[] = [];
  for (const workerId of ["worker", "replacement"]) {
    const f = await fixture();
    try {
      if (workerId !== "worker") {
        await f.db.query(
          "INSERT INTO current_grants VALUES ($1,TRUE,'invocation','authorized-space')",
          [workerId],
        );
      }
      f.caller.principal.workerId = workerId;
      const outcome = await f.execute("stable-step", [
        f.create("stable-record"),
      ]);
      outcomes.push({
        recordIds: (outcome.result as { recordIds: string[] }).recordIds,
        events: (await f.db.query(
          "SELECT deduplication_id,subject_id FROM events ORDER BY seq",
        )).rows,
      });
    } finally {
      await f.close();
    }
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});
