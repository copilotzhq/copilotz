import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotz } from "../../create-copilotz.ts";
import { createCopilotzGateway } from "./gateway.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { defineProcessor } from "../plugins/processor.ts";

function database() {
  const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
  return createTestDatabase(url ? { url, pgPoolMax: 4 } : {});
}
const schema = () => `host_${crypto.randomUUID().replaceAll("-", "")}`;

Deno.test("requested idle schema recovers overdue work before factory readiness without scanning other schemas", async () => {
  const db = await database();
  const primary = schema(), requested = schema(), unopened = schema();
  const handled = Promise.withResolvers<void>();
  const processor = defineProcessor({
    id: "host.startup",
    on: [{ eventType: "overdue.work" }],
    handle() {
      handled.resolve();
    },
  });
  for (const scoped of [requested, unopened]) {
    await provisionCopilotzSchema(db, scoped);
    await provisionOperationCatalog(db, scoped);
    const store = createEventStore({ session: db, schema: scoped });
    await store.append(
      { type: "overdue.work", namespace: "idle", payload: {} },
      ["processor:host.startup"],
    );
    const owner = await openDatabaseOwner(db, scoped);
    // The store's lazy owner and this explicit attachment are both test-owned.
    await releaseDatabaseOwner(owner);
    await releaseDatabaseOwner(owner);
  }
  const placement: string[] = [];
  const app = await createCopilotz({
    database: db,
    databaseSchema: primary,
    databaseScopes: [requested, requested],
    processors: { startup: processor },
    onDeliveryDiagnostic(event) {
      if (event.phase === "placement_requested") {
        placement.push(event.databaseSchema ?? "");
      }
    },
  });
  try {
    assert(placement.includes(requested));
    assert(!placement.includes(unopened));
    const ownerRows = await db.query<{ epoch: number }>(
      `SELECT epoch FROM "${requested}".owner_epochs WHERE owner='schema'`,
    );
    assertEquals(Number(ownerRows.rows[0].epoch), 2);
    assertEquals(
      Number(
        (await db.query<{ epoch: number }>(
          `SELECT epoch FROM "${unopened}".owner_epochs WHERE owner='schema'`,
        )).rows[0].epoch,
      ),
      1,
    );
    await handled.promise;
  } finally {
    await app.close();
    await db.close();
  }
});

Deno.test("partial explicit scope startup releases every opened owner and preserves retained data", async () => {
  const db = await database();
  const primary = schema(), valid = schema(), missing = schema();
  await provisionCopilotzSchema(db, valid);
  await provisionOperationCatalog(db, valid);
  const preparedOwner = await openDatabaseOwner(db, valid);
  await releaseDatabaseOwner(preparedOwner);
  await releaseDatabaseOwner(preparedOwner);
  await db.query(
    `INSERT INTO "${valid}".nodes(id,namespace,type,name) VALUES('retained','space','record','retained')`,
  );
  try {
    await assertRejects(() =>
      createCopilotzGateway({
        database: db,
        databaseSchema: primary,
        databaseScopes: [valid, missing],
      })
    );
    assertEquals((await db.query(`SELECT id FROM "${valid}".nodes`)).rows, [{
      id: "retained",
    }]);
    const previousEpochs = new Map<string, number>();
    for (const scoped of [primary, valid]) {
      previousEpochs.set(
        scoped,
        Number(
          (await db.query<{ epoch: number }>(
            `SELECT epoch FROM "${scoped}".owner_epochs WHERE owner='schema'`,
          )).rows[0].epoch,
        ),
      );
    }
    const app = await createCopilotzGateway({
      database: db,
      databaseSchema: primary,
      databaseScopes: [valid],
    });
    try {
      for (const scoped of [primary, valid]) {
        assertEquals(
          Number(
            (await db.query<{ epoch: number }>(
              `SELECT epoch FROM "${scoped}".owner_epochs WHERE owner='schema'`,
            )).rows[0].epoch,
          ),
          previousEpochs.get(scoped)! + 1,
        );
      }
    } finally {
      await app.close();
    }
  } finally {
    await db.close();
  }
});

Deno.test("invalid startup scopes fail before a database connector opens", async () => {
  let opens = 0;
  await assertRejects(
    () =>
      createCopilotz({
        databaseScopes: ["bad;schema"],
        database: {
          connect() {
            opens++;
            throw new Error("must not open");
          },
        },
      }),
    TypeError,
    "schema",
  );
  assertEquals(opens, 0);
});
