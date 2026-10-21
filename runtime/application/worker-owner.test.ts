import { assertEquals } from "@std/assert";
import { createCopilotz, defineAction } from "../../index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

Deno.test("a colocated worker executes with gateway capabilities without opening storage", async () => {
  const database = await createTestDatabase();
  const databaseSchema = "worker_owner_capabilities";
  const transport = {
    type: "in-process",
    config: { topic: crypto.randomUUID() },
  } as const;
  const actions = {
    echo: defineAction({
      id: "test.echo",
      execute: (input: { value: string }) => input.value,
    }),
  };
  const gateway = await createCopilotz({
    role: "gateway",
    database,
    databaseSchema,
    namespace: "space",
    transports: [transport],
    target: { workerId: "worker" },
    actions,
  });
  const worker = await createCopilotz({
    role: "worker",
    databaseSchema,
    namespace: "space",
    transport,
    id: "worker",
    actions,
  });
  try {
    await worker.ready;
    assertEquals(
      await gateway.actions.echo({ value: "owner execution" }, {
        idempotencyKey: "echo",
      }),
      "owner execution",
    );
    assertEquals(
      (await database.query<{ epoch: number }>(
        `SELECT epoch FROM "${databaseSchema}".owner_epochs WHERE owner='schema'`,
      )).rows.map((row) => Number(row.epoch)),
      [1],
    );
  } finally {
    await worker.close();
    await gateway.close();
    await database.close();
  }
});

Deno.test("a nested worker Action outlives the transport default without retrying", async () => {
  const database = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const databaseSchema = "worker_nested_call_deadline";
  const transport = {
    type: "in-process",
    config: { topic: crypto.randomUUID() },
  } as const;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const actions = {
    outer: defineAction({
      id: "test.outer",
      execute: (_input, context) => context.actions.slow({}),
    }),
    slow: defineAction({
      id: "test.slow",
      async execute() {
        calls++;
        entered.resolve();
        await release.promise;
        return "complete nested response";
      },
    }),
  };
  const gateway = await createCopilotz({
    role: "gateway",
    database,
    databaseSchema,
    namespace: "space",
    transports: [transport],
    target: { workerId: "worker" },
    actions,
  });
  const worker = await createCopilotz({
    role: "worker",
    databaseSchema,
    namespace: "space",
    transport,
    id: "worker",
    actions,
  });
  try {
    await worker.ready;
    const result = gateway.actions.outer({}, { idempotencyKey: "long-call" })
      .then((value) => ({ value }), (error) => ({ error }));
    await entered.promise;
    // Oxian clamps each call to the worker's configured hostCalls.timeoutMs;
    // an explicit call deadline alone cannot exceed its 30-second default.
    await new Promise((resolve) => setTimeout(resolve, 31_000));
    release.resolve();
    assertEquals(await result, { value: "complete nested response" });
    assertEquals(calls, 1);
  } finally {
    release.resolve();
    await worker.close();
    await gateway.close();
    await database.query(`DROP SCHEMA IF EXISTS "${databaseSchema}" CASCADE`);
    await database.close();
  }
});
