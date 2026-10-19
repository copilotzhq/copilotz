import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotz, defineAction } from "../../index.ts";
import type { CopilotzDatabase } from "../persistence/index.ts";
import { provisionCopilotzSchema } from "../events/index.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCopilotzGateway,
  type CreateCopilotzGatewayOptions,
} from "./gateway.ts";
import { createCopilotzApplication } from "./application.ts";

for (const mode of ["local", "worker"] as const) {
  Deno.test(`${mode} reconnect replaces every opened scope and capability host after an unknown admission commit`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim() || ":memory:",
    });
    const primary = `reconnect_${crypto.randomUUID().replaceAll("-", "")}`;
    const secondary = `${primary}_secondary`;
    await provisionCopilotzSchema(db, secondary);
    await provisionOperationCatalog(db, secondary);
    const preparedOwner = await openDatabaseOwner(db, secondary);
    releaseDatabaseOwner(preparedOwner);
    releaseDatabaseOwner(preparedOwner);
    const transport = {
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    } as const;
    let generation = 0;
    let loseCommit = false;
    const ready = Promise.withResolvers<void>();
    const calls: string[] = [];
    const actions = {
      echo: defineAction({
        id: "reconnect.echo",
        execute(input: { value: string }) {
          calls.push(input.value);
          return input.value;
        },
      }),
    };
    const options: CreateCopilotzGatewayOptions = {
      databaseSchema: primary,
      namespace: "tenant",
      databaseScopes: [secondary],
      actions,
      transports: [transport],
      target: { workerId: "worker" },
      database: {
        connect() {
          generation++;
          const transaction: CopilotzDatabase["transaction"] = async (
            callback,
          ) => {
            let admitted = false;
            const result = await db.transaction(async (transaction) =>
              await callback({
                query: async (sql, params) => {
                  if (
                    sql.includes("inserted_event") &&
                    JSON.stringify(params).includes("host:uncertain")
                  ) admitted = true;
                  return await transaction.query(sql, params);
                },
              })
            );
            if (loseCommit && admitted) {
              loseCommit = false;
              throw Object.assign(new Error("connection reset after COMMIT"), {
                code: "ECONNRESET",
              });
            }
            return result;
          };
          return {
            query: db.query,
            transaction,
            close: () => Promise.resolve(),
          };
        },
      },
      databaseLifecycle: {
        onReady({ generation }) {
          if (generation === 2) ready.resolve();
        },
      },
    };
    const local = mode === "local"
      ? await createCopilotzApplication(options)
      : undefined;
    const gateway = local
      ? { application: local, actions: local.host.actions, close: local.close }
      : await createCopilotzGateway(options);
    await local?.startRecovery();
    const worker = mode === "worker"
      ? await createCopilotz({
        role: "worker",
        id: "worker",
        transport,
        namespace: "tenant",
        actions,
      })
      : undefined;
    const epoch = async (schema: string) =>
      Number(
        (await db.query<{ epoch: string }>(
          `SELECT epoch FROM "${schema}".owner_epochs WHERE owner='schema'`,
        )).rows[0].epoch,
      );
    try {
      await worker?.ready;
      assertEquals(await gateway.actions.echo({ value: "before" }), "before");
      const priorPrimary = await epoch(primary);
      const priorSecondary = await epoch(secondary);
      const oldSecondary = await gateway.application.databaseScope(secondary);
      // Lose the acknowledgement after the admission and its receipt are durable.
      loseCommit = true;
      await assertRejects(() =>
        gateway.actions.echo({ value: "once" }, {
          databaseSchema: secondary,
          idempotencyKey: "uncertain",
        })
      );
      await ready.promise;
      assertEquals(generation, 2);
      assertEquals(await epoch(primary), priorPrimary + 1);
      assertEquals(await epoch(secondary), priorSecondary + 1);
      assert(
        oldSecondary !== await gateway.application.databaseScope(secondary),
      );
      await assertRejects(() =>
        oldSecondary.events.append({
          type: "stale",
          namespace: "tenant",
          payload: {},
        })
      );
      assertEquals(
        await gateway.actions.echo({ value: "once" }, {
          databaseSchema: secondary,
          idempotencyKey: "uncertain",
        }),
        "once",
      );
      assertEquals(await gateway.actions.echo({ value: "after" }), "after");
      assertEquals(calls, ["before", "once", "after"]);
    } finally {
      await worker?.close();
      await gateway.close();
      await db.query(`DROP SCHEMA "${primary}" CASCADE`);
      await db.query(`DROP SCHEMA "${secondary}" CASCADE`);
      await db.close();
    }
  });
}
