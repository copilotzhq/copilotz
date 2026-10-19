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
import { joinCollectionRuntime } from "./joined-runtime.ts";
import { createCollectionRuntime } from "./kernel.ts";
import { captureCollectionPolicy } from "./policy-authorization.ts";
import {
  captureCollectionInvocation,
  type CollectionInvocationAuthority,
  withOwnerCollectionInvocation,
} from "./policy-invocation.ts";
import { validateCollectionPolicies } from "./policy-registration.ts";

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
  await run("policy.setup", {}, async (_input, { transaction }) => {
    await transaction.query(
      `CREATE TABLE "${schema}".policy_state (allowed boolean NOT NULL)`,
    );
    await transaction.query(
      `INSERT INTO "${schema}".policy_state VALUES (true)`,
    );
  });
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
      return { event: source.event, data: { retained: true }, ancestors: [] };
    },
  };
  const registration = {
    alias: "records",
    name: record.name,
    policy: {
      async authorize(
        intent: import("./policy-types.ts").CollectionPolicyIntent,
        context: import("./policy-types.ts").CollectionPolicyContext,
      ) {
        assertEquals(context.invocation, authority.invocation);
        assertEquals(context.scope, authority.scope);
        assertEquals((await context.resolveSource()).data, { retained: true });
        const state = await context.query<{ allowed: boolean }>(
          `SELECT allowed FROM "${schema}".policy_state`,
        );
        if (closed && intent.phase === "result") resultAfterClose++;
        if (!state.rows[0].allowed) {
          throw new ActionError("Current policy denied.", {
            code: "forbidden",
            status: 403,
          });
        }
      },
    },
  };
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },
    flushCommitted() {
      published++;
      return Promise.resolve({ handles: [], failures: [] });
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
    policies: validateCollectionPolicies({ records: registration.policy }, {
      records: record,
    }),
  });
  runtime.bind(record);
  let captured!: CollectionInvocationAuthority;
  const adopt = async (command: CommandContext) => {
    const joined = joinCollectionRuntime(runtime, { records: record }, command);
    try {
      await withOwnerCollectionInvocation(authority, async () => {
        captured = captureCollectionInvocation()!;
        await joined.runtime.transaction({
          namespace: "space",
          operationKey: "adopt",
          async execute({ collections }) {
            await collections.policy_record.create({ id: "one", name: "one" });
          },
        });
      });
    } finally {
      joined.close();
      closed = true;
    }
    assertThrows(() => captured.check(), Error, "authority has ended");
    await assertRejects(
      () =>
        joined.runtime.withScope({ namespace: "space" }).policy_record.create({
          id: "late",
          name: "late",
        }),
      Error,
    );
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
      releaseDatabaseOwner(owner);
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
                `UPDATE "${f.schema}".policy_state SET allowed=false`,
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
            `SELECT allowed FROM "${f.schema}".policy_state`,
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
            args: { id: "one", name: "one" },
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
