import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ActionError } from "../actions/errors.ts";
import { ActionOwnershipLost } from "../actions/ownership.ts";
import {
  type CommandContext,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { assertOwnerInvocationLive } from "../engine/invocation-liveness.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { defineCollection } from "./definition.ts";

import { createCollectionRuntime } from "./kernel.ts";
import { captureCollectionPolicy } from "../authorization/collection.ts";
import {
  captureCollectionInvocation,
  type CollectionInvocationAuthority,
  withOwnerCollectionInvocation,
} from "../authorization/invocation.ts";
import { testCollectionAuthorizations } from "../testing/collection-authorization.ts";
import { testAuthority } from "../testing/authority.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const record = defineCollection({
  name: "policy_record",
  ownerPolicy: "required",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id", "name"],
  } as const,
});

async function fixture() {
  const db = await createTestDatabase({ url, pgPoolMax: 4 });
  const schema = `policy_command_${crypto.randomUUID().replaceAll("-", "")}`;
  const binding = testAuthority(schema);
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  const source = await store.append({
    namespace: "space",
    type: "policy.source",
    payload: {},
  }, ["processor"]);
  const deliveryId = source.deliveries[0].id;
  await store.claimDelivery({
    id: deliveryId,
    owner: "attempt",
    leaseMs: 60_000,
  });
  const controller = new AbortController();
  const run = createSchemaCommandRunner(db, schema);
  const membership = defineCollection({
    name: "policy_state",
    schema: { type: "object" },
  });
  await run("policy.setup", {}, (_, command) =>
    command.transaction.query(
      `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('state','space','policy_state','state','{"allowed":true}')`,
    ));
  let closed = false;
  let checkedAfterClose = 0;
  let sourceAfterClose = 0;
  let resultAfterClose = 0;
  let published = 0;
  const authority: CollectionInvocationAuthority = {
    scope: { databaseSchema: schema, namespace: "space" },
    invocation: { kind: "processor", id: "processor", runId: "attempt" },
    signal: controller.signal,
    check() {
      controller.signal.throwIfAborted();
      if (closed) checkedAfterClose++;
    },
    assertCurrent: (read) =>
      assertOwnerInvocationLive(read, {
        databaseSchema: schema,
        namespace: "space",
        eventId: source.event.id,
        writer: { deliveryId, leaseOwner: "attempt" },
      }),
    async resolveSource(transaction) {
      const rows = await transaction.query(
        `SELECT id FROM "${schema}".events WHERE id=$1 AND namespace='space'`,
        [source.event.id],
      );
      assertEquals(rows.rows.length, 1);
      if (closed) sourceAfterClose++;
      return {
        event: source.event,
        data: { retained: true },
        ingress: { kind: "host" as const, authority: binding },
        ancestors: [],
      };
    },
  };
  const registrations = testCollectionAuthorizations(
    { records: record, membership },
    schema,
    async ({ intent, read }) => {
      const phase = (intent
        .input as import("../authorization/intent.ts").CollectionPolicyIntent)
        .phase;
      if (closed && phase === "result") resultAfterClose++;
      if (!(await read.get("membership", "state"))?.allowed) {
        throw new ActionError("Current policy denied.", {
          code: "forbidden",
          status: 403,
        });
      }
      return {
        collections: { records: {} },
        collectionMutations: {
          records: { create: {}, update: {}, delete: {} },
        },
      };
    },
  );
  const registration = registrations.get(record.name)!;
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({
          ...input,
          consumers: [],
          onCommitted() {
            published++;
          },
        }),
        dispatch: { handles: [], failures: [] },
      };
    },
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  const runtime = createCollectionRuntime({
    session: db,
    eventStore: store,
    coordinator,
    policies: registrations,
  });
  runtime.bind(record);
  let captured!: CollectionInvocationAuthority;
  const adopt = async (command: CommandContext) => {
    try {
      await withOwnerCollectionInvocation(authority, async () => {
        captured = captureCollectionInvocation()!;
        await runtime.transaction({
          namespace: "space",
          operationKey: "adopt",
          async execute({ collections }) {
            await collections.policy_record.create({ id: "one", name: "one" });
          },
        }, command);
      });
    } finally {
      closed = true;
    }
    assertThrows(() => captured.check(), Error, "authority has ended");
  };
  return {
    db,
    schema,
    run,
    authority,
    registration,
    controller,
    deliveryId,
    adopt,
    checks: () => ({ checkedAfterClose, sourceAfterClose, resultAfterClose }),
    published: () => published,
    async count() {
      return Number(
        (await db.query<{ count: string }>(
          `SELECT count(*) FROM "${schema}".nodes WHERE type=$1`,
          [record.name],
        )).rows[0].count,
      );
    },
    async close() {
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test({
  name:
    "joined policy rechecks owner, provenance and current permission after its public call closes",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      await f.run("policy.allowed", {}, (_input, command) => f.adopt(command));
      assertEquals(await f.count(), 1);
      assert(f.checks().checkedAfterClose > 0);
      assert(f.checks().sourceAfterClose > 0);
      assertEquals(f.checks().resultAfterClose, 1);
      assertEquals(f.published(), 1);
    } finally {
      await f.close();
    }
  },
});

for (const denial of ["policy", "assignment", "signal"] as const) {
  Deno.test({
    name:
      `joined policy ${denial} retirement after callback closure rolls back its outer transaction`,
    ignore: !url,
    async fn() {
      const f = await fixture();
      try {
        const error = await assertRejects(() =>
          f.run("policy.refused", {}, async (_input, command) => {
            await f.adopt(command);
            if (denial === "policy") {
              await command.transaction.query(
                `UPDATE "${f.schema}".nodes SET data='{"allowed":false}' WHERE id='state'`,
              );
            } else if (denial === "assignment") {
              await command.transaction.query(
                `UPDATE "${f.schema}".event_deliveries SET lease_owner='retired' WHERE id=$1`,
                [f.deliveryId],
              );
            } else {
              f.controller.abort(new Error("Invocation cancelled."));
            }
          })
        );
        if (denial === "policy") {
          assert(error instanceof ActionError);
          assertEquals(error.code, "forbidden");
          assertEquals(f.checks().resultAfterClose, 1);
        } else if (denial === "assignment") {
          assert(error instanceof ActionOwnershipLost);
        } else {
          assertEquals((error as Error).message, "Invocation cancelled.");
        }
        assertEquals(await f.count(), 0);
        assertEquals(f.published(), 0);
        assertEquals(
          (await f.db.query(
            `SELECT (data->>'allowed')::boolean AS allowed FROM "${f.schema}".nodes WHERE id='state'`,
          )).rows,
          [{ allowed: true }],
        );
        assertEquals(
          (await f.db.query(
            `SELECT lease_owner FROM "${f.schema}".event_deliveries WHERE id=$1`,
            [f.deliveryId],
          )).rows,
          [{ lease_owner: "attempt" }],
        );
      } finally {
        await f.close();
      }
    },
  });
}

Deno.test({
  name:
    "command policy cannot be minted by an expired call or reused by another command",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let retained!: ReturnType<
      ReturnType<typeof captureCollectionPolicy>["forCommand"]
    >;
    try {
      await f.run("policy.capture", {}, async (_input, command) => {
        let policy!: ReturnType<typeof captureCollectionPolicy>;
        await withOwnerCollectionInvocation(f.authority, () => {
          policy = captureCollectionPolicy({
            registration: f.registration,
            namespace: "space",
            databaseSchema: f.schema,
            method: "create",
            args: { input: { id: "one", name: "one" } },
          });
          retained = policy.forCommand(command);
        });
        assertThrows(() => policy.check(), Error, "authority has ended");
        assertThrows(
          () => policy.forCommand(command),
          Error,
          "authority has ended",
        );
        await assertRejects(
          () => policy.authorize(command, "result"),
          Error,
          "authority has ended",
        );
        await retained.authorize(command, "result");
        await assertRejects(
          async () =>
            await retained.authorize({
              transaction: command.transaction,
              commandTime: "2000-01-01T00:00:00.000Z",
            }, "result"),
          Error,
          "authority has ended",
        );
      });
      assertThrows(() => retained.check(), Error, "active SQL transaction");
      await f.run("policy.other-command", {}, async (_input, command) => {
        await assertRejects(
          async () => await retained.authorize(command, "result"),
          Error,
          "authority has ended",
        );
      });
    } finally {
      await f.close();
    }
  },
});
