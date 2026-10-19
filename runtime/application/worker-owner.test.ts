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
