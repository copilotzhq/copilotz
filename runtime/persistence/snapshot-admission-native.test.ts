import { assertEquals, assertRejects } from "@std/assert";
import { provisionCopilotzSchema } from "../events/index.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { bounded, localPostgresUrl } from "../testing/effect-commit-proxy.ts";
import {
  createOminipgSqlSession,
  openManagedOminipgDatabase,
} from "./ominipg.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const latch = () => Promise.withResolvers<void>();
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
for (const backend of ["pglite", "postgres"] as const) {
  Deno.test({
    name:
      `${backend} native admission preserves repeatable snapshot and mixed-write progress with capacity refusal`,
    ignore: backend === "postgres" && !url,
    async fn() {
      const managed = await openManagedOminipgDatabase(
        backend === "postgres"
          ? { url: localPostgresUrl(url!), pgPoolMax: 4 }
          : {},
      );
      const db = managed.database,
        a = createOminipgSqlSession(db),
        b = createOminipgSqlSession(db);
      const table = `admission_${crypto.randomUUID().replaceAll("-", "")}`;
      const entered = latch(), release = latch();
      const events: string[] = [];
      let first: Promise<unknown> | undefined,
        write: Promise<unknown> | undefined,
        second: Promise<unknown> | undefined;
      try {
        await db.query(`CREATE TABLE "${table}"(value integer)`);
        first = a.withReadSnapshot!(async (scope) => {
          assertEquals(
            scope.kind,
            backend === "postgres" ? "pooled" : "exclusive",
          );
          assertEquals(
            (await scope.snapshot.query(`SELECT value FROM "${table}"`)).rows,
            [],
          );
          events.push("A");
          entered.resolve();
          await release.promise;
          assertEquals(
            (await scope.snapshot.query(`SELECT value FROM "${table}"`)).rows,
            [],
          );
          events.push("A ends");
        });
        await bounded(entered.promise, "native A opens");
        write = db.transaction(async (tx) => {
          await tx.query(`INSERT INTO "${table}" VALUES (42)`);
        }).then(() => {
          events.push("write committed");
        });
        await assertRejects(() =>
          b.withReadSnapshot!(() => Promise.resolve(0))
        );
        if (backend === "postgres") {
          await bounded(write, "pooled write commits while A stays held");
        } else {
          await tick();
          assertEquals(events, ["A"]);
        }
        release.resolve();
        await bounded(first, "native A cleans up");
        await bounded(write, "ordinary write commits");
        second = b.withReadSnapshot!(async (scope) => {
          events.push("B");
          return (await scope.snapshot.query(`SELECT value FROM "${table}"`))
            .rows;
        });
        assertEquals(await bounded(second, "native B opens"), [{ value: 42 }]);
        assertEquals(
          events.indexOf("write committed") < events.indexOf("B"),
          true,
        );
        if (backend === "postgres") {
          assertEquals(events, ["A", "write committed", "A ends", "B"]);
        } else assertEquals(events, ["A", "A ends", "write committed", "B"]);
        console.log(
          `CAUSAL ${backend}: ${
            events.join(" -> ")
          }; B sees committed write; A remains repeatable.`,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([first, write, second]);
        await db.query(`DROP TABLE IF EXISTS "${table}"`);
        await managed.close();
      }
    },
  });
}

async function fixture() {
  const managed = await openManagedOminipgDatabase({
    url: localPostgresUrl(url!),
    pgPoolMax: 4,
  });
  const session = managed.session;
  const schema = `ancestry_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(session, schema);
  const owner = await openDatabaseOwner(session, schema);
  return {
    session,
    owner,
    caller: { principal: "fixture", epoch: owner.epoch! },
    async close() {
      releaseDatabaseOwner(owner);
      await session.query(`DROP SCHEMA "${schema}" CASCADE`);
      await managed.close();
    },
  };
}
Deno.test({
  name:
    "live snapshot awaiting its queued owner child refuses another same-physical snapshot promptly",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let backendEntered = false;
    const child = f.owner.register("snapshot.child", {
      authorize() {},
      async execute() {
        const error = await assertRejects(() =>
          bounded(
            f.session.withReadSnapshot!(async () => {
              await Promise.resolve();
              backendEntered = true;
            }),
            "nested owner snapshot refuses",
          )
        );
        assertEquals(
          (error as { code: string }).code,
          "persistence_unavailable",
        );
        return "refused";
      },
    });
    try {
      assertEquals(
        await bounded(
          f.session.withReadSnapshot!(async () =>
            await child(f.caller, { input: {} })
          ),
          "outer snapshot and child both complete",
        ),
        "refused",
      );
      assertEquals(backendEntered, false);
    } finally {
      await f.close();
    }
  },
});
Deno.test({
  name:
    "queued owner work can open a snapshot after the previous session closes",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const entered = latch(), release = latch();
    let pending: Promise<string> | undefined,
      blocking: Promise<void> | undefined;
    const hold = f.owner.register("snapshot.blocker", {
      authorize() {},
      async execute() {
        entered.resolve();
        await release.promise;
      },
    });
    const child = f.owner.register("snapshot.later", {
      authorize() {},
      async execute() {
        return await f.session.withReadSnapshot!(async () =>
          await Promise.resolve("later")
        );
      },
    });
    try {
      blocking = hold(f.caller, { input: {} });
      await bounded(entered.promise, "unrelated owner blocker");
      await f.session.withReadSnapshot!(async () => {
        await Promise.resolve();
        pending = child(f.caller, { input: {} });
      });
      release.resolve();
      await blocking;
      assertEquals(
        await bounded(pending!, "inactive ancestry admits"),
        "later",
      );
    } finally {
      release.resolve();
      await Promise.allSettled([blocking, pending]);
      await f.close();
    }
  },
});

Deno.test("PGlite extension configuration refuses uncertified exclusive snapshots", async () => {
  const managed = await openManagedOminipgDatabase({
    pgliteExtensions: ["vector"],
  });
  let entered = false;
  try {
    await assertRejects(
      () =>
        managed.session.withReadSnapshot!(() => {
          entered = true;
          return Promise.resolve();
        }),
      Error,
      "Exclusive snapshots are unsupported by this PGlite configuration",
    );
    assertEquals(entered, false);
  } finally {
    await managed.close();
  }
});
