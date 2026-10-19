import { digestContent } from "../content/digest.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/index.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { defineCollection } from "../collections/definition.ts";
import { loadCollectionRecord } from "../collections/reducer.ts";
import { queryCollectionRecords } from "../collections/query.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { testAuthority } from "../testing/authority.ts";
import {
  authorizationRefused,
  captureOwnerAuthorization,
  createOwnerEvaluator,
  type OwnerAuthorization,
  validateOwnerAuthorization,
} from "./evaluator.ts";
import type { StaffAuthorizationSource } from "./directory.ts";

Deno.test("F4 declared directory staff reads are fresh per command, fail closed and audit in the tenant", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 4,
  });
  const directoryDb = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 2,
  });
  const schema = `staff_target_${crypto.randomUUID().replaceAll("-", "")}`;
  const directorySchema = `staff_directory_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  await provisionCopilotzSchema(db, schema);
  await provisionCopilotzSchema(directoryDb, directorySchema);
  const owner = await openDatabaseOwner(db, schema);
  const directoryOwner = await openDatabaseOwner(directoryDb, directorySchema);
  const run = createSchemaCommandRunner(db, schema);
  const directoryRun = createSchemaCommandRunner(directoryDb, directorySchema);
  const directoryTables = createCoreTableNames(directorySchema);
  const grants = defineCollection({
    name: "staff_grant",
    schema: { type: "object" },
  });
  const local = defineCollection({
    name: "local_role",
    schema: { type: "object" },
  });
  let reads = 0, unavailable = false, swallow = false, useList = false;
  const source: StaffAuthorizationSource = {
    kind: "platform-staff",
    alias: "staff",
    owner: "directory-owner",
    namespace: "directory",
    collection: grants.name,
    read: {
      get(id, signal) {
        reads++;
        signal.throwIfAborted();
        if (unavailable) {
          return Promise.reject(new Error("Directory unavailable"));
        }
        return directoryRun(
          "staff.read",
          { id },
          (_, command) =>
            loadCollectionRecord(
              command.transaction,
              directoryTables,
              "directory",
              grants.name,
              id,
            ),
        );
      },
      list(query, signal) {
        reads++;
        signal.throwIfAborted();
        if (unavailable) {
          return Promise.reject(new Error("Directory unavailable"));
        }
        return directoryRun(
          "staff.list",
          {},
          (_, command) =>
            queryCollectionRecords(
              command.transaction,
              directoryTables,
              grants,
              "directory",
              query,
            ),
        );
      },
    },
  };
  const registration: OwnerAuthorization = {
    policies: {
      fixture: {
        revision: "1",
        sources: ["local", source],
        async evaluate({ read, authority, intent }) {
          assertEquals((await read.get("local", "member"))?.role, "staff");
          try {
            const grant = useList
              ? (await read.list("staff", {
                where: { id: authority.principal.id },
                limit: 1,
              }))[0]
              : await read.get("staff", authority.principal.id);
            if (
              !grant?.allowed || grant.tenant !== authority.scope.tenant ||
              grant.operation !== intent.operation
            ) authorizationRefused();
          } catch (error) {
            if (!swallow) throw error;
          }
          return { sessions: { create: true } };
        },
      },
    },
    collections: {},
    actions: {},
  };
  const captured = captureOwnerAuthorization(registration, { local }, {})!;
  const evaluate = createOwnerEvaluator({
    registration: captured,
    collections: { local },
    databaseSchema: schema,
  });
  const authority = testAuthority(schema);
  const intent = {
    kind: "session" as const,
    resource: "requested-session",
    operation: "create",
    input: null,
  };
  const setGrant = (allowed: boolean) =>
    directoryRun("staff.set", {}, async (_, command) => {
      await command.transaction.query(
        `INSERT INTO "${directorySchema}".nodes(id,namespace,type,name,data) VALUES('member','directory','staff_grant','member',$1::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`,
        [JSON.stringify({ allowed, tenant: "fixture", operation: "create" })],
      );
    });
  const audit = async () =>
    (await db.query<
      {
        intent: {
          operation: unknown;
          sources: unknown;
          principal: unknown;
          scope: { tenant: string };
        };
      }
    >(`SELECT intent FROM "${schema}".owner_receipts WHERE kind='authorization.staff'`))
      .rows;
  const command = () =>
    run("staff.operation", {}, async (_, context) => {
      const decision = await evaluate(authority, intent, context);
      if (!decision.constraints.sessions?.create) authorizationRefused();
      await context.transaction.query(
        `INSERT INTO "${schema}".nodes(id,namespace,type,name) VALUES($1,'space','operation','operation')`,
        [crypto.randomUUID()],
      );
    });
  try {
    await run(
      "local.role",
      {},
      (_, context) =>
        context.transaction.query(
          `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('member','space','local_role','member','{"role":"staff"}')`,
        ),
    );
    // Even a tenant-local role literally named staff cannot supply directory authority.
    await assertRejects(command);
    assertEquals((await audit()).length, 0);
    await setGrant(true);
    await command();
    const entries = await audit();
    assertEquals(entries.length, 1);
    assertEquals(entries[0].intent.principal, authority.principal);
    assertEquals(entries[0].intent.scope.tenant, "fixture");
    assertEquals(entries[0].intent.operation, {
      kind: "session",
      resource: "requested-session",
      operation: "create",
      inputDigest: await digestContent(new TextEncoder().encode("null")),
    });
    assertEquals(entries[0].intent.sources, [{
      owner: "directory-owner",
      namespace: "directory",
      collection: "staff_grant",
      id: "member",
    }]);
    assertEquals(
      (await directoryDb.query(
        `SELECT count(*)::int AS n FROM "${directorySchema}".owner_receipts WHERE kind='authorization.staff'`,
      )).rows,
      [{ n: 0 }],
    );
    await setGrant(false);
    await assertRejects(command);
    assertEquals(reads, 3);
    await setGrant(true);
    unavailable = true;
    swallow = true;
    await assertRejects(command, Error, "could not be completed");
    assertEquals((await audit()).length, 1);
    unavailable = false;
    swallow = false;
    const before = reads;
    await run("staff.finish", {}, async (_, context) => {
      await evaluate(authority, intent, context);
      await setGrant(false);
      await evaluate(authority, intent, context);
    });
    assertEquals(reads - before, 1);
    await assertRejects(command);
    await setGrant(true);
    useList = true;
    await command();
    await setGrant(false);
    await assertRejects(command);
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM "${schema}".nodes WHERE type='operation'`,
      )).rows,
      [{ n: 2 }],
    );
    // Local aliases cannot impersonate a declared directory source.
    assertThrows(
      () =>
        validateOwnerAuthorization(registration, { local, staff: local }, {}),
      TypeError,
    );
    assertThrows(
      () =>
        validateOwnerAuthorization(
          {
            ...registration,
            policies: {
              fixture: {
                ...registration.policies.fixture,
                sources: [source, source],
              },
            },
          },
          { local },
          {},
        ),
      TypeError,
    );
    const undeclared = createOwnerEvaluator({
      registration: {
        ...registration,
        policies: {
          fixture: { ...registration.policies.fixture, sources: ["local"] },
        },
      },
      collections: { local },
      databaseSchema: schema,
    });
    await assertRejects(
      () =>
        run(
          "staff.undeclared",
          {},
          (_, context) => undeclared(authority, intent, context),
        ),
      Error,
      "could not be completed",
    );
    assert((await audit()).length >= 3);
    await setGrant(true);
    const longLived = {
      ...authority,
      principal: { kind: "service" as const, id: "member" },
      validity: {
        kind: "credential" as const,
        admittedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    };
    await run("staff.channel-admission", {}, async (_, context) => {
      const decision = await evaluate(longLived, intent, context);
      assertEquals(decision.authority.validity.kind, "credential");
      if (decision.authority.validity.kind === "credential") {
        assertEquals(
          Date.parse(decision.authority.validity.expiresAt) -
            Date.parse(context.commandTime),
          15 * 60 * 1000,
        );
      }
    });
    const beforeCommands = reads;
    const first = run("staff.first", {}, async (_, context) => {
      await evaluate(authority, intent, context);
      await setGrant(false);
    });
    const second = assertRejects(command);
    await first;
    await second;
    assertEquals(reads - beforeCommands, 2);
  } finally {
    releaseDatabaseOwner(owner);
    releaseDatabaseOwner(directoryOwner);
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await directoryDb.query(`DROP SCHEMA "${directorySchema}" CASCADE`);
    await db.close();
    await directoryDb.close();
  }
});
