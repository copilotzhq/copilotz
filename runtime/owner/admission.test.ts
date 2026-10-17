import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import type { AnyActionDefinition } from "../actions/types.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerInputCommand,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerActionAdmission,
  OWNER_ACTION_ADMISSION,
  ownerActionAdmissionKey,
  validateOwnerActionAdmissionIdentity,
} from "./admission.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const ownerId = "owner";
const namespace = "space";
const provenance = {
  principal: "private-principal-marker",
  route: "fixture.root",
  restrictions: { values: {}, absentKeys: ["computerOperationKind"] },
};
const metadata = { label: "private-metadata-marker" };
const caller = (workerId = "ingress-a", ownerEpoch = 1): OwnerCaller => ({
  workerId,
  ownerEpoch,
  authenticated: true,
});
const request = (
  overrides: Record<string, OwnerJson> = {},
): OwnerInputCommand => {
  const input = {
    namespace,
    actionAlias: "work",
    requestId: "request-a",
    input: {
      text: "private-body-marker",
      list: [1, 2],
      nested: { a: 1, b: 2 },
    },
    metadata,
    provenance,
    ...overrides,
  };
  return {
    kind: OWNER_ACTION_ADMISSION,
    domain: "logical",
    key: ownerActionAdmissionKey(
      ownerId,
      String(input.namespace),
      String(input.requestId),
    ),
    input,
  };
};
const errorCode = (code: string) => (error: unknown): boolean =>
  !!error && typeof error === "object" &&
  (error as { code?: string }).code === code;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tables = [
  "event_bodies",
  "events",
  "event_deliveries",
  "owner_receipts",
  "owner_receipt_readers",
  "owner_epochs",
  "copilotz_operations",
  "copilotz_operation_events",
];
async function snapshot(tx: SqlExecutor) {
  return Object.fromEntries(
    await Promise.all(tables.map(async (table) => [
      table,
      (await tx.query(
        `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
      )).rows,
    ])),
  );
}
async function fixture(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  actions?: Record<string, AnyActionDefinition>,
  maxPendingDeliveries?: number,
) {
  const f = await setup(actions, maxPendingDeliveries);
  try {
    await run(f);
  } finally {
    await f.db.close();
  }
}
async function setup(
  actions?: Record<string, AnyActionDefinition>,
  maxPendingDeliveries?: number,
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOperationCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  await db.query(`CREATE TABLE fixture_ingress (worker_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL, action_alias TEXT NOT NULL, provenance JSONB NOT NULL,
    metadata JSONB NOT NULL, live BOOLEAN NOT NULL DEFAULT TRUE)`);
  await db.query(
    `INSERT INTO fixture_ingress VALUES ($1,$2,'work',$3::jsonb,$4::jsonb,TRUE)`,
    [
      "ingress-a",
      namespace,
      JSON.stringify(provenance),
      JSON.stringify(metadata),
    ],
  );
  const state = {
    scheduled: [] as OwnerJson[],
    authorized: 0,
    handled: 0,
    receiptLookups: 0,
    inTransaction: false,
    failReaders: false,
    failRelease: false,
    rejectOuter: false,
    gateCommit: false,
    uncommitted: undefined as Awaited<ReturnType<typeof snapshot>> | undefined,
  };
  const gate = { reached: deferred(), release: deferred() };
  const published = deferred();
  const session: SqlSession = {
    query: db.query,
    async transaction(callback) {
      state.inTransaction = true;
      try {
        return await db.transaction(async (tx) => {
          const result = await callback({
            async query(sql, params) {
              if (/SELECT kind,intent,result FROM/.test(sql)) {
                state.receiptLookups++;
              }
              if (
                state.failReaders &&
                /INSERT INTO .*owner_receipt_readers/.test(sql)
              ) {
                state.failReaders = false;
                state.uncommitted = await snapshot(tx);
                throw new Error("injected receipt reader failure");
              }
              if (
                state.failRelease && sql === "RELEASE SAVEPOINT owner_command_0"
              ) {
                state.failRelease = false;
                state.uncommitted = await snapshot(tx);
                throw new Error("injected release failure");
              }
              return tx.query(sql, params);
            },
          });
          if (state.rejectOuter) {
            state.rejectOuter = false;
            state.uncommitted = await snapshot(tx);
            throw new Error("injected outer rollback");
          }
          if (state.gateCommit) {
            state.gateCommit = false;
            state.uncommitted = await snapshot(tx);
            gate.reached.resolve();
            await gate.release.promise;
          }
          return result;
        });
      } finally {
        state.inTransaction = false;
      }
    },
  };
  const registry = createPluginRegistry({
    actions: actions ?? {
      work: defineAction({
        id: "fixture.work",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            list: { type: "array", items: { type: "number" } },
          },
          required: ["text"],
        } as const,
        execute: () => {
          throw new Error("Admission must not execute Actions");
        },
      }),
    },
  });
  const admission = createOwnerActionAdmission({
    ownerId,
    maxPendingDeliveries,
    session,
    schema: "public",
    registry,
    catalog: createOperationCatalog(db, "public"),
    schedule(reference) {
      assert.equal(state.inTransaction, false);
      state.scheduled.push(reference);
      published.resolve();
    },
  });
  const createOwner = (holderId: string) =>
    createOwnerCommandBoundary({
      session,
      schema: "public",
      ownerId,
      holderId,
      handlers: {
        [OWNER_ACTION_ADMISSION]: async (intent, context) => {
          state.handled++;
          return await admission.handler(intent, context);
        },
      },
      inputDefinitions: { [OWNER_ACTION_ADMISSION]: admission.inputDefinition },
      async authorize(tx, who, command, _time, input) {
        state.authorized++;
        validateOwnerActionAdmissionIdentity(ownerId, command, input);
        if (who.authenticated !== true) {
          throw new Error("unauthenticated ingress");
        }
        const trusted = (await tx.query<{
          namespace: string;
          action_alias: string;
          provenance: OwnerJson;
          metadata: OwnerJson;
          live: boolean;
        }>("SELECT * FROM fixture_ingress WHERE worker_id=$1", [who.workerId]))
          .rows[0];
        if (!trusted?.live) {
          throw new Error("current ingress authority revoked");
        }
        if (
          input.namespace !== trusted.namespace ||
          input.actionAlias !== trusted.action_alias
        ) {
          throw new Error("current ingress scope denied");
        }
        // A digest proves equality only. Current host state authenticates and
        // reconstructs these values before every receipt lookup, including replay.
        assert.deepEqual(
          input.provenance,
          trusted.provenance,
          "untrusted provenance",
        );
        assert.deepEqual(
          input.metadata,
          trusted.metadata,
          "untrusted metadata",
        );
      },
      authenticateReceipt(_tx, who) {
        if (who.authenticated !== true) {
          throw new Error("unauthenticated recovery");
        }
      },
    });
  const owner = createOwner("holder-a");
  await owner.acquire(0);
  return {
    db,
    owner,
    createOwner,
    state,
    gate,
    published,
    admission,
    registry,
  };
}

// Real SQL/session tests over PGlite. These are not proof of PostgreSQL
// connection-loss recovery or public HTTP/effect-aware execution readiness.
test("root admission persists original body and safe durable references with ordinary retry policy", async () => {
  await fixture(async ({ db, owner, state, published }) => {
    const command = request();
    const outcome = await owner.executeInput(caller(), command);
    await published.promise;
    assert.equal(outcome.status, "committed");
    const result = outcome.result as Record<string, string>;
    assert.deepEqual(Object.keys(result).sort(), [
      "actionId",
      "deliveryId",
      "eventId",
      "executionId",
      "namespace",
    ]);
    assert.equal(result.namespace, namespace);
    assert.equal(result.actionId, "fixture.work");
    assert.deepEqual(state.scheduled, [result]);
    const event = (await db.query("SELECT * FROM events")).rows[0];
    assert.equal(event.id, result.eventId);
    assert.equal(event.owner_id, ownerId);
    assert.equal(String(event.seq), "1");
    assert.equal(event.type, "copilotz.owner.action.requested");
    assert.deepEqual(event.metadata, {
      actionId: "fixture.work",
      actionRunId: result.executionId,
      requestId: "request-a",
      actionMetadata: metadata,
      ingress: provenance,
    });
    const body = (await db.query("SELECT * FROM event_bodies")).rows[0];
    assert.deepEqual(
      body.body,
      (command.input as Record<string, OwnerJson>).input,
    );
    assert.deepEqual(event.payload, {
      dataRef: {
        eventBodyId: body.event_body_id,
        schemaVersion: 1,
        mediaType: "application/json",
      },
    });
    const delivery = (await db.query("SELECT * FROM event_deliveries")).rows[0];
    assert.equal(delivery.id, result.deliveryId);
    assert.equal(delivery.event_id, result.eventId);
    assert.equal(delivery.consumer_id, "registered:fixture.work");
    assert.equal(delivery.max_attempts, 3);
    assert.equal(delivery.attempts, 0);
    assert.equal(delivery.status, "pending");
    assert.equal(state.handled, 1);
    assert.equal(
      (await db.query("SELECT * FROM copilotz_operations")).rows.length,
      1,
    );
    assert.equal(
      (await db.query("SELECT * FROM copilotz_operation_events")).rows.length,
      1,
    );
  });
});

test("root admission canonicalizes nested object order but retains array order and all intent data", async () => {
  await fixture(async ({ db, owner, state }) => {
    const first = await owner.executeInput(caller(), request());
    const reordered = request({
      input: {
        nested: { b: 2, a: 1 },
        list: [1, 2],
        text: "private-body-marker",
      },
      provenance: {
        restrictions: { values: {}, absentKeys: ["computerOperationKind"] },
        route: "fixture.root",
        principal: "private-principal-marker",
      },
    });
    assert.deepEqual(await owner.executeInput(caller(), reordered), {
      ...first,
      status: "duplicate",
    });
    for (
      const input of [
        { text: "private-body-marker", list: [2, 1], nested: { a: 1, b: 2 } },
        { text: "changed", list: [1, 2], nested: { a: 1, b: 2 } },
        { text: "private-body-marker", list: [1, 2], nested: { a: 2, b: 2 } },
      ]
    ) {
      await assert.rejects(
        owner.executeInput(caller(), request({ input })),
        errorCode("owner_intent_conflict"),
      );
    }
    const changes: Record<string, OwnerJson>[] = [
      { provenance: { ...provenance, principal: "another-principal" } },
      {
        provenance: {
          ...provenance,
          restrictions: {
            values: { computerOperationKind: null },
            absentKeys: [],
          },
        },
      },
      { provenance: { ...provenance, restrictions: {} } },
      { metadata: { label: "changed-metadata" } },
    ];
    for (const changed of changes) {
      await db.query(
        "UPDATE fixture_ingress SET provenance=$1::jsonb, metadata=$2::jsonb",
        [
          JSON.stringify(
            "provenance" in changed ? changed.provenance : provenance,
          ),
          JSON.stringify("metadata" in changed ? changed.metadata : metadata),
        ],
      );
      await assert.rejects(
        owner.executeInput(caller(), request(changed)),
        errorCode("owner_intent_conflict"),
      );
    }
    assert.equal(state.handled, 1);
    assert.equal((await db.query("SELECT * FROM event_bodies")).rows.length, 1);
    assert.equal(
      String(
        (await db.query("SELECT last_seq FROM owner_epochs")).rows[0].last_seq,
      ),
      "1",
    );
  });
});

test("root admission rejects caller digests, extra keys, missing fields and bypass routes", async () => {
  await fixture(async ({ db, owner, state }) => {
    const baseline = await snapshot(db);
    for (
      const field of [
        "digest",
        "intent",
        "actionId",
        "hostEffectsSafe",
        "maxAttempts",
      ]
    ) {
      await assert.rejects(
        owner.executeInput(caller(), request({ [field]: "caller-controlled" })),
        /explicit input, metadata and provenance/,
      );
    }
    for (
      const field of [
        "input",
        "metadata",
        "provenance",
        "namespace",
        "actionAlias",
        "requestId",
      ]
    ) {
      const command = request();
      const input = { ...(command.input as Record<string, OwnerJson>) };
      delete input[field];
      await assert.rejects(
        owner.executeInput(caller(), { ...command, input }),
        /explicit input, metadata and provenance/,
      );
    }
    await assert.rejects(
      owner.execute(caller(), {
        kind: OWNER_ACTION_ADMISSION,
        domain: "logical",
        key: request().key,
        intent: {
          encoding: "copilotz.action-admission.v1",
          digest: "sha256:caller",
        },
      }),
      errorCode("owner_command_invalid"),
    );
    assert.equal(state.authorized, 0);
    assert.equal(state.handled, 0);
    assert.deepEqual(await snapshot(db), baseline);
  });
});

test("current host provenance, metadata and revocation checks precede duplicate lookup", async () => {
  await fixture(async ({ db, owner, state }) => {
    const first = await owner.executeInput(caller(), request());
    const baseline = await snapshot(db);
    const lookups = state.receiptLookups;
    await assert.rejects(
      owner.executeInput(
        caller(),
        request({
          provenance: { ...provenance, principal: "forged-principal" },
        }),
      ),
      /untrusted provenance/,
    );
    await assert.rejects(
      owner.executeInput(caller(), request({ metadata: { label: "forged" } })),
      /untrusted metadata/,
    );
    await db.query("UPDATE fixture_ingress SET live=FALSE");
    await assert.rejects(
      owner.executeInput(caller(), request()),
      /current ingress authority revoked/,
    );
    assert.equal(state.receiptLookups, lookups);
    assert.deepEqual(await snapshot(db), baseline);
    assert.equal(state.handled, 1);
    await db.query("UPDATE fixture_ingress SET live=TRUE");
    assert.deepEqual(await owner.executeInput(caller(), request()), {
      ...first,
      status: "duplicate",
    });
  });
});

test("root identity is namespace and owner bound before deduplication", async () => {
  await fixture(async ({ db, owner, state }) => {
    await owner.executeInput(caller(), request());
    const lookups = state.receiptLookups;
    const baseline = await snapshot(db);
    const alteredNamespace = request({ namespace: "other-space" });
    for (
      const command of [
        { ...alteredNamespace, key: request().key },
        {
          ...request(),
          key: ownerActionAdmissionKey("other-owner", namespace, "request-a"),
        },
        {
          ...request(),
          key: ownerActionAdmissionKey(ownerId, namespace, "other-request"),
        },
        { ...request(), domain: "occurrence" as const },
      ]
    ) {
      await assert.rejects(
        owner.executeInput(caller(), command),
        /identity does not match/,
      );
    }
    await assert.rejects(
      owner.executeInput(caller(), alteredNamespace),
      /current ingress scope denied/,
    );
    assert.equal(state.receiptLookups, lookups);
    assert.deepEqual(await snapshot(db), baseline);
    assert.notEqual(
      ownerActionAdmissionKey(ownerId, "a,b", "c"),
      ownerActionAdmissionKey(ownerId, "a", "b,c"),
    );
  });
});

test("root admission commits body, event, delivery, receipt, reader and sequence before scheduling", async () => {
  await fixture(async ({ owner, state, gate, published }) => {
    state.gateCommit = true;
    let returned = false;
    const pending = owner.executeInput(caller(), request()).then((value) => {
      returned = true;
      return value;
    });
    await gate.reached.promise;
    assert.equal(returned, false);
    assert.deepEqual(state.scheduled, []);
    for (const table of tables.filter((table) => table !== "owner_epochs")) {
      assert.equal(state.uncommitted![table].length, 1, table);
    }
    assert.equal(
      String(
        (state.uncommitted!.owner_epochs[0].row as Record<string, unknown>)
          .last_seq,
      ),
      "1",
    );
    gate.release.resolve();
    const result = await pending;
    await published.promise;
    assert.deepEqual(state.scheduled, [result.result]);
  });
});

test("failed root commands roll back body, event, delivery, receipt, sequence and readers without scheduling", async () => {
  await fixture(async ({ db, owner, state, published }) => {
    const baseline = await snapshot(db);
    for (const failure of ["failReaders", "failRelease"] as const) {
      state[failure] = true;
      await assert.rejects(owner.executeInput(caller(), request()), /injected/);
      assert.equal(state.uncommitted!.event_bodies.length, 1);
      assert.equal(state.uncommitted!.events.length, 1);
      assert.equal(state.uncommitted!.owner_receipts.length, 1);
      assert.deepEqual(await snapshot(db), baseline);
      assert.deepEqual(state.scheduled, []);
    }
    await owner.executeInput(caller(), request());
    await published.promise;
    assert.equal(state.scheduled.length, 1);
    assert.equal(
      String((await db.query("SELECT seq FROM events")).rows[0].seq),
      "1",
    );
  });
});

test("outer rollback publishes nothing and successor recovery sees no root receipt", async () => {
  await fixture(async ({ db, owner, createOwner, state }) => {
    const baseline = await snapshot(db);
    state.rejectOuter = true;
    await assert.rejects(
      owner.executeInput(caller(), request()),
      errorCode("owner_commit_unknown"),
    );
    assert.equal(state.uncommitted!.owner_receipt_readers.length, 1);
    assert.deepEqual(await snapshot(db), baseline);
    assert.deepEqual(state.scheduled, []);
    const successor = createOwner("holder-b");
    await successor.acquire(1);
    assert.equal(
      await successor.readReceipt(caller("ingress-a", 2), {
        domain: "logical",
        key: request().key,
      }),
      undefined,
    );
    assert.equal(
      (await successor.executeInput(caller("ingress-a", 2), request())).status,
      "committed",
    );
  });
});

test("root receipts and post-takeover recovery never disclose input, metadata or provenance", async () => {
  await fixture(async ({ db, owner, createOwner, state }) => {
    const outcome = await owner.executeInput(caller(), request());
    const receipt = await owner.readReceipt(caller(), {
      domain: "logical",
      key: request().key,
    });
    assert.deepEqual(receipt?.result, outcome.result);
    assert.match(
      (receipt!.intent as { digest: string }).digest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(Object.keys(receipt!.intent as object).sort(), [
      "digest",
      "encoding",
    ]);
    assert.equal(
      (receipt!.intent as { encoding: string }).encoding,
      "copilotz.action-admission.v1",
    );
    const successor = createOwner("holder-b");
    await successor.acquire(1);
    await db.query("UPDATE fixture_ingress SET live=FALSE");
    assert.deepEqual(
      await successor.readReceipt(caller("ingress-a", 2), {
        domain: "logical",
        key: request().key,
      }),
      receipt,
    );
    assert.equal(
      await successor.readReceipt(caller("other-worker", 2), {
        domain: "logical",
        key: request().key,
      }),
      undefined,
    );
    const stored = JSON.stringify(
      (await db.query("SELECT row_to_json(r) FROM owner_receipts r")).rows,
    );
    for (
      const value of [
        "private-body-marker",
        "private-principal-marker",
        "private-metadata-marker",
        "restrictions",
        "actionMetadata",
        "provenance",
      ]
    ) {
      assert.equal(stored.includes(value), false);
      assert.equal(JSON.stringify(receipt).includes(value), false);
      assert.equal(JSON.stringify(state.scheduled).includes(value), false);
    }
    await assert.rejects(
      successor.executeInput(caller("ingress-a", 2), request()),
      /current ingress authority revoked/,
    );
  });
});

test("root ordinary schema validation and protected/content/deferred refusal precede all writes", async () => {
  const plain = defineAction({
    id: "fixture.plain",
    inputSchema: { type: "string" } as const,
    execute: (value: string) => value,
  });
  const protectedInput = defineAction({
    id: "fixture.protected",
    inputSchema: { type: "string", "x-copilotz-secret": true } as const,
    execute: (value: string) => value,
  });
  const protectedOutput = defineAction({
    id: "fixture.protected-output",
    outputSchema: {
      type: "object",
      properties: { nested: { type: "string", "x-copilotz-secret": true } },
    } as const,
    execute: () => ({ nested: "secret" }),
  });
  const content = defineAction({
    id: "fixture.content",
    content: { input: ["attachments"] },
    execute: () => null,
  });
  const deferredAction = defineAction({
    id: "fixture.deferred",
    execute: () => null,
    resolve: () => null,
  });
  await fixture(async ({ db, owner, state }) => {
    const baseline = await snapshot(db);
    await assert.rejects(
      owner.executeInput(caller(), request()),
      /Action input failed schema validation/,
    );
    for (
      const actionAlias of [
        "protectedInput",
        "protectedOutput",
        "content",
        "deferredAction",
      ]
    ) {
      await assert.rejects(
        owner.executeInput(caller(), request({ actionAlias, input: "test" })),
        /does not yet support protected\/content\/deferred Actions/,
      );
    }
    for (const actionAlias of ["unknown", "toString", "__proto__"]) {
      await assert.rejects(
        owner.executeInput(caller(), request({ actionAlias })),
        /Unknown registered Action/,
      );
    }
    assert.equal(state.authorized, 0);
    assert.deepEqual(await snapshot(db), baseline);
    assert.equal(
      (await owner.executeInput(caller(), request({ input: "ordinary input" })))
        .status,
      "committed",
    );
  }, { work: plain, protectedInput, protectedOutput, content, deferredAction });
});

test("root capacity is atomic for new work while authorized duplicates replay at capacity", async () => {
  await fixture(
    async ({ db, owner, state }) => {
      const results = await Promise.allSettled(
        ["a", "b", "c"].map((requestId) =>
          owner.executeInput(caller(), request({ requestId }))
        ),
      );
      assert.deepEqual(results.map((result) => result.status), [
        "fulfilled",
        "fulfilled",
        "rejected",
      ]);
      assert.equal(
        (results[2] as PromiseRejectedResult).reason.code,
        "owner_admission_refused",
      );
      assert.equal((await db.query("SELECT * FROM events")).rows.length, 2);
      const first =
        (results[0] as PromiseFulfilledResult<{ result: OwnerJson }>).value;
      for (const status of ["pending", "leased", "retry_wait"]) {
        await db.query("UPDATE event_deliveries SET status=$1", [status]);
        const baseline = await snapshot(db);
        assert.deepEqual(
          await owner.executeInput(caller(), request({ requestId: "a" })),
          {
            status: "duplicate",
            result: first.result,
          },
        );
        await assert.rejects(
          owner.executeInput(caller(), request({ requestId: "c" })),
          errorCode("owner_admission_refused"),
        );
        assert.deepEqual(await snapshot(db), baseline);
      }
      assert.equal(state.scheduled.length, 2);
      await db.query("UPDATE event_deliveries SET status='succeeded'");
      assert.equal(
        (await owner.executeInput(caller(), request({ requestId: "c" })))
          .status,
        "committed",
      );
      assert.equal(
        String(
          (await db.query("SELECT last_seq FROM owner_epochs")).rows[0]
            .last_seq,
        ),
        "3",
      );
      assert.equal(
        (await db.query("SELECT * FROM owner_receipt_readers")).rows.length,
        3,
      );
    },
    undefined,
    2,
  );
});

test("root capacity defaults to 128 unsettled deliveries and refuses invalid limits", async () => {
  await fixture(async ({ db, owner, registry }) => {
    await owner.executeInput(caller(), request());
    await db.query(`INSERT INTO event_deliveries (
      id,event_id,consumer_id,settlement_scope_id,status,attempts,max_attempts,
      available_at,created_at,updated_at
    ) SELECT 'other-' || n, d.event_id, 'other-' || n, d.settlement_scope_id,
      'pending',0,3,NOW(),NOW(),NOW()
      FROM event_deliveries d CROSS JOIN generate_series(1,127) n`);
    const baseline = await snapshot(db);
    await assert.rejects(
      owner.executeInput(caller(), request({ requestId: "new" })),
      errorCode("owner_admission_refused"),
    );
    assert.equal(
      (await owner.executeInput(caller(), request())).status,
      "duplicate",
    );
    assert.deepEqual(await snapshot(db), baseline);
    for (
      const maxPendingDeliveries of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]
    ) {
      assert.throws(() =>
        createOwnerActionAdmission({
          ownerId,
          schema: "public",
          session: db,
          registry,
          catalog: createOperationCatalog(db, "public"),
          maxPendingDeliveries,
          schedule() {},
        }), /positive safe integer/);
    }
  });
});

test("root admission refuses whitespace retargeting and invalid scope values before authority", async () => {
  await fixture(async ({ db, owner, state }) => {
    const baseline = await snapshot(db);
    for (const field of ["namespace", "actionAlias", "requestId"]) {
      for (
        const value of [
          "",
          " ",
          " space",
          "space ",
          "\tspace",
          "x".repeat(1025),
          null,
          1,
        ]
      ) {
        await assert.rejects(
          owner.executeInput(caller(), request({ [field]: value })),
          (error: unknown) =>
            error instanceof Error &&
            (/identifiers/.test(error.message) ||
              errorCode("owner_command_invalid")(error)),
        );
      }
    }
    for (const field of ["metadata", "provenance"]) {
      for (const value of [null, [], "invalid", 1]) {
        await assert.rejects(
          owner.executeInput(caller(), request({ [field]: value })),
          /requires an object/,
        );
      }
    }
    assert.equal(state.authorized, 0);
    assert.deepEqual(await snapshot(db), baseline);
  });
});

test("root admission explicitly refuses content-shaped JSON that would lose original fields", async () => {
  await fixture(async ({ db, owner, state }) => {
    const baseline = await snapshot(db);
    const ref = {
      assetId: "asset-a",
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    };
    const extras: Record<string, OwnerJson>[] = [{
      value: "original-content-value",
    }, {
      arbitrary: "original-extra-field",
    }];
    for (const extra of extras) {
      await assert.rejects(
        owner.executeInput(
          caller(),
          request({
            input: { text: "ordinary", nested: [{ ...ref, ...extra }] },
          }),
        ),
        /content-shaped data that changes when persisted/,
      );
    }
    for (const field of ["metadata", "provenance"]) {
      await assert.rejects(
        owner.executeInput(
          caller(),
          request({
            [field]: { nested: { ...ref, privateFact: "must-not-disappear" } },
          }),
        ),
        /content-shaped data that changes when persisted/,
      );
    }
    assert.equal(state.authorized, 0);
    assert.deepEqual(await snapshot(db), baseline);
    // Descriptor-only data is unchanged by shared body encoding and remains
    // legal ordinary JSON. This does not grant content hydration authority.
    const command = request({
      input: { text: "ordinary", nested: [{ ...ref, resolve: false }] },
    });
    await owner.executeInput(caller(), command);
    assert.deepEqual(
      (await db.query("SELECT body FROM event_bodies")).rows[0].body,
      (command.input as Record<string, OwnerJson>).input,
    );
  });
});
