import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createOwnerCommandBoundary, type OwnerCaller } from "./boundary.ts";
import {
  provisionOwnerCommandSchema,
  validateOwnerCommandSchema,
} from "./schema.ts";

const caller = (principal: unknown, ownerEpoch = 1) =>
  ({ principal, ownerEpoch }) as unknown as OwnerCaller;
const worker = (id = "worker") => caller({ kind: "worker", workerId: id });
const control = (changes = {}) =>
  caller({
    kind: "owner-control",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    ...changes,
  });
const local = (changes = {}) =>
  caller({
    kind: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    deliveryId: "delivery",
    attemptId: "attempt",
    ...changes,
  });
const command = (key = "key", intent = "value") => ({
  kind: "put",
  domain: "logical" as const,
  key,
  intent,
});
const code = (expected: string) => (error: unknown) =>
  (error as { code?: unknown })?.code === expected;
async function fixture(
  run: (f: {
    db: Awaited<ReturnType<typeof createTestDatabase>>;
    owner: ReturnType<typeof createOwnerCommandBoundary>;
    calls: { authorize: number; receipt: number; write: number };
  }) => Promise<void>,
) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    await provisionOwnerCommandSchema(db, "public");
    const calls = { authorize: 0, receipt: 0, write: 0 };
    const owner = createOwnerCommandBoundary({
      session: db,
      schema: "public",
      ownerId: "owner",
      holderId: "holder",
      handlers: {
        async put(value, ctx) {
          calls.write++;
          await ctx.tx.query(
            "INSERT INTO public.nodes(id,namespace,type,name,data) VALUES($1,'test','note',$1,'{}')",
            [ctx.command.key],
          );
          if (value === "fail") throw new Error("handler failed");
          return value;
        },
      },
      authorize() {
        calls.authorize++;
      },
      authenticateReceipt() {
        calls.receipt++;
      },
    });
    await owner.acquire(0);
    try {
      await run({ db, owner, calls });
    } finally {
      owner.stop();
    }
  } finally {
    await db.close();
  }
}

test("principal tags preserve logical receipt identity and separate provenance/readers", async () => {
  await fixture(async ({ db, owner, calls }) => {
    assert.equal(
      (await owner.execute(control(), command())).status,
      "committed",
    );
    assert.equal((await owner.execute(local(), command())).status, "duplicate");
    assert.equal(
      (await owner.execute(worker(), command())).status,
      "duplicate",
    );
    assert.equal(calls.write, 1);
    assert.deepEqual(
      (await db.query(
        "SELECT principal_kind,principal_id FROM public.owner_receipts",
      )).rows,
      [{
        principal_kind: "owner-control",
        principal_id: '["owner",1,"holder"]',
      }],
    );
    assert.deepEqual(
      (await db.query(
        "SELECT principal_kind,principal_id FROM public.owner_receipt_readers ORDER BY principal_kind",
      )).rows,
      [
        {
          principal_kind: "owner-control",
          principal_id: '["owner",1,"holder"]',
        },
        {
          principal_kind: "owner-local",
          principal_id: '["owner",1,"holder","delivery","attempt"]',
        },
        { principal_kind: "worker", principal_id: '["worker"]' },
      ],
    );
    assert.equal(
      (await owner.readReceipt(worker(), { domain: "logical", key: "key" }))
        ?.result,
      "value",
    );
    assert.equal(
      await owner.readReceipt(worker('["owner",1,"holder"]'), {
        domain: "logical",
        key: "key",
      }),
      undefined,
    );
    for (const who of [control(), local()]) {
      await assert.rejects(
        owner.readReceipt(who, { domain: "logical", key: "key" }),
        code("owner_receipt_principal_refused"),
      );
    }
    assert.equal(calls.receipt, 2);
  });
});

test("owner principal mismatches fail before authorization or durable writes", async () => {
  await fixture(async ({ db, owner, calls }) => {
    for (
      const who of [
        control({ ownerId: "other" }),
        control({ holderId: "other" }),
        control({ epoch: 2 }),
        local({ ownerId: "other" }),
        local({ holderId: "other" }),
        local({ epoch: 2 }),
      ]
    ) {
      await assert.rejects(
        owner.execute(who, command()),
        code("ActionOwnershipLost"),
      );
    }
    assert.equal(calls.authorize, 0);
    assert.equal(calls.write, 0);
    assert.equal(
      (await db.query("SELECT 1 FROM public.owner_receipts")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT 1 FROM public.owner_receipt_readers")).rows
        .length,
      0,
    );
  });
});

test("principal schema validation refuses weakened types, nullability, and constraints", async () => {
  await fixture(async ({ db }) => {
    const changes = [
      "ALTER TABLE public.owner_receipts ALTER COLUMN principal_kind DROP NOT NULL",
      "ALTER TABLE public.owner_receipts ALTER COLUMN principal_id TYPE VARCHAR(8192)",
      "ALTER TABLE public.owner_receipt_readers ALTER COLUMN principal_id TYPE VARCHAR(8192)",
      "ALTER TABLE public.owner_receipts DROP CONSTRAINT owner_receipts_principal_check",
      "ALTER TABLE public.owner_receipt_readers DROP CONSTRAINT owner_receipt_readers_principal_check",
      "ALTER TABLE public.owner_receipts DROP CONSTRAINT owner_receipts_principal_check; ALTER TABLE public.owner_receipts ADD CONSTRAINT owner_receipts_principal_check CHECK (true)",
    ];
    for (const change of changes) {
      await db.transaction(async (tx) => {
        await tx.query("SAVEPOINT weakened");
        for (const sql of change.split(";")) await tx.query(sql);
        await assert.rejects(
          validateOwnerCommandSchema(tx, "public", "owner"),
          code("owner_schema_not_provisioned"),
        );
        await tx.query("ROLLBACK TO SAVEPOINT weakened");
      });
    }
  });
});

test("malformed and mixed principal shapes never reach authorization", async () => {
  await fixture(async ({ owner, calls }) => {
    const invalid = [
      null,
      [],
      { kind: "worker" },
      { kind: ["worker"], workerId: "worker" },
      { kind: "worker", workerId: "worker", ownerId: "owner" },
      { kind: "worker", workerId: "x".repeat(1025) },
      { kind: "owner-control", ownerId: "owner", epoch: 0, holderId: "holder" },
      {
        kind: "owner-control",
        ownerId: "owner",
        epoch: "1",
        holderId: "holder",
      },
      {
        kind: "owner-local",
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
        deliveryId: "delivery",
        attemptId: "",
      },
      {
        kind: "owner-local",
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
        deliveryId: "delivery",
        attemptId: "attempt",
        workerId: "worker",
      },
      {
        kind: "owner-local",
        ownerId: "\u0001".repeat(1024),
        epoch: 1,
        holderId: "\u0002".repeat(1024),
        deliveryId: "delivery",
        attemptId: "attempt",
      },
    ];
    for (const principal of invalid) {
      await assert.rejects(
        owner.execute(caller(principal), command()),
        code("owner_command_invalid"),
      );
    }
    await assert.rejects(
      owner.execute({ ...worker(), workerId: "legacy" }, command()),
      code("owner_command_invalid"),
    );
    assert.equal(calls.authorize, 0);
  });
});

test("tagged reader association rolls back with writes and refuses conflicting replay", async () => {
  await fixture(async ({ db, owner }) => {
    await assert.rejects(
      owner.execute(local(), command("failed", "fail")),
      /handler failed/,
    );
    for (const table of ["nodes", "owner_receipts", "owner_receipt_readers"]) {
      assert.equal(
        (await db.query(`SELECT 1 FROM public.${table}`)).rows.length,
        0,
      );
    }
    await owner.execute(control(), command());
    await assert.rejects(
      owner.execute(worker("new"), command("key", "conflict")),
      code("owner_intent_conflict"),
    );
    assert.equal(
      await owner.readReceipt(worker("new"), { domain: "logical", key: "key" }),
      undefined,
    );
    assert.equal(
      (await db.query("SELECT 1 FROM public.owner_receipt_readers")).rows
        .length,
      1,
    );
    assert.equal(
      (await owner.execute(local({ attemptId: "attempt-2" }), command()))
        .status,
      "duplicate",
    );
    assert.equal(
      (await db.query("SELECT 1 FROM public.owner_receipts")).rows.length,
      1,
    );
  });
});

test("worker receipt association stays narrow across epochs without owner-role escalation", async () => {
  await fixture(async ({ db, owner }) => {
    await owner.execute(worker(), command());
    const successor = createOwnerCommandBoundary({
      session: db,
      schema: "public",
      ownerId: "owner",
      holderId: "successor",
      handlers: {},
      authorize() {},
      authenticateReceipt() {},
    });
    await successor.acquire(1);
    try {
      assert.equal(
        (await successor.readReceipt(worker(), {
          domain: "logical",
          key: "key",
        }))?.result,
        "value",
      );
      await assert.rejects(
        successor.readReceipt(
          caller({
            kind: "owner-control",
            ownerId: "owner",
            epoch: 2,
            holderId: "successor",
          }, 2),
          { domain: "logical", key: "key" },
        ),
        code("owner_receipt_principal_refused"),
      );
      await assert.rejects(
        successor.project(control(), "missing", null),
        code("owner_command_invalid"),
      );
    } finally {
      successor.stop();
    }
  });
});
