import { testUpgradeOptions } from "../testing/upgrade.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import {
  provisionCopilotzSchema,
  validateCopilotzSchema,
} from "../events/schema.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { openDatabaseOwner, readSchemaReceipt } from "../engine/commands.ts";
import {
  prepareRetainedDataUpgrade,
  upgradeActionLifecycle,
} from "./upgrade.ts";

async function fixture() {
  const db = await createOwnerTestDatabase();
  const schema = "receipt_upgrade";
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  (await openDatabaseOwner(db, schema)).stop();
  await db.query(`ALTER TABLE "${schema}".owner_receipts DROP COLUMN readers`);
  const columns = async () =>
    (await db.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,column_name",
      [schema],
    )).rows;
  const marker = async () =>
    (await db.query(`SELECT * FROM "${schema}".copilotz_schema_metadata`)).rows;
  const receipts = async () =>
    (await db.query(`SELECT * FROM "${schema}".owner_receipts ORDER BY key`))
      .rows;
  const add = (principal: string, key = "retained") =>
    db.query(
      `INSERT INTO "${schema}".owner_receipts(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,$2,'collections.commit','{"step":"same"}','null')`,
      [key, principal],
    );
  return { db, schema, columns, marker, receipts, add };
}

Deno.test("offline upgrade preserves fixed receipt principals and grants while requests reject an incomplete current shape", async () => {
  const f = await fixture();
  try {
    await f.add("host:fixed");
    const before = {
      columns: await f.columns(),
      marker: await f.marker(),
      receipts: await f.receipts(),
    };
    await assertRejects(
      () => provisionCopilotzSchema(f.db, f.schema),
      Error,
      "readers",
    );
    await assertRejects(
      () => upgradeActionLifecycle(f.db, f.schema),
      Error,
      "readers",
    );
    assertEquals({
      columns: await f.columns(),
      marker: await f.marker(),
      receipts: await f.receipts(),
    }, before);
    await f.db.query(
      `UPDATE "${f.schema}".copilotz_schema_metadata SET version=9`,
    );
    const options = await testUpgradeOptions(f.db, f.schema);
    await upgradeActionLifecycle(f.db, f.schema, options);
    await upgradeActionLifecycle(f.db, f.schema, options);
    await validateCopilotzSchema(f.db, f.schema);
    const upgraded = await f.receipts();
    const after = upgraded.filter((receipt) => receipt.key === "retained");
    assertEquals(
      upgraded.filter((receipt) => receipt.principal === "offline-upgrade")
        .map((receipt) => receipt.kind).sort(),
      ["authorization.upgrade", "owner-keys.upgrade"],
    );
    assertEquals(
      after.map(({ readers: _readers, ...receipt }) => receipt),
      before.receipts,
    );
    assertEquals(after[0].readers, ["host:fixed"]);
    assertEquals(
      await readSchemaReceipt(f.db, f.schema, "worker:replacement", {
        key: "retained",
        databaseSchema: f.schema,
        intent: { step: "same" },
      }),
      false,
    );
  } finally {
    await f.db.close();
  }
});

for (const phase of ["preparation", "finalization"] as const) {
  Deno.test(`offline receipt authority refusal at ${phase} leaves exact source data and readiness untouched`, async () => {
    const f = await fixture();
    try {
      await f.db.query(
        `UPDATE "${f.schema}".copilotz_schema_metadata SET version=9`,
      );
      const plan = phase === "finalization"
        ? await prepareRetainedDataUpgrade(f.db, f.schema)
        : undefined;
      if (phase === "finalization") assert(plan);
      await f.add("worker:original");
      const before = {
        columns: await f.columns(),
        marker: await f.marker(),
        receipts: await f.receipts(),
      };
      await assertRejects(
        () =>
          upgradeActionLifecycle(
            f.db,
            f.schema,
            plan ? { plan, reviewedFingerprint: plan.fingerprint } : {},
          ),
        Error,
        "reviewed durable invocation authority mapping",
      );
      assertEquals({
        columns: await f.columns(),
        marker: await f.marker(),
        receipts: await f.receipts(),
      }, before);
    } finally {
      await f.db.close();
    }
  });
}
