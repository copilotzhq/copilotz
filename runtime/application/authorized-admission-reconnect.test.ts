import { assertEquals } from "@std/assert";
import { defineAction, definePlugin } from "../../index.ts";
import { serverPlugin } from "../../plugins/server/plugin.ts";
import type { CopilotzDatabase } from "../persistence/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { until } from "../testing/effect-commit-proxy.ts";
import {
  createTestCopilotz as createCopilotz,
  defineTestServerFacade,
} from "../testing/server-authorization.test.ts";

for (const reconnect of [true, false]) {
  Deno.test(`authorized admission lost commit returns 503 with reconnect=${reconnect}`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
    });
    const schema = `authorized_reconnect_${
      crypto.randomUUID().replaceAll("-", "")
    }`;
    let generation = 0, loseCommit = true, executions = 0;
    const ready = Promise.withResolvers<void>();
    const app = await createCopilotz({
      namespace: "scope",
      databaseSchema: schema,
      database: {
        connect({ signal }) {
          generation++;
          if (generation > 1 && !reconnect) {
            return new Promise<CopilotzDatabase>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          }
          return {
            query: db.query,
            async transaction(callback) {
              let admitted = false;
              const value = await db.transaction(async (tx) =>
                await callback({
                  async query(sql, params) {
                    if (
                      sql.includes("inserted_event") &&
                      JSON.stringify(params).includes("uncertain")
                    ) {
                      admitted = true;
                    }
                    return await tx.query(sql, params);
                  },
                })
              );
              if (admitted && loseCommit) {
                loseCommit = false;
                throw Object.assign(
                  new Error("connection reset after COMMIT"),
                  { code: "ECONNRESET" },
                );
              }
              return value;
            },
            close: () => Promise.resolve(),
          } satisfies CopilotzDatabase;
        },
      },
      databaseRecovery: { waitMs: 20, retryAfterSeconds: 3 },
      databaseLifecycle: {
        onReady({ generation }) {
          if (generation === 2) ready.resolve();
        },
      },
      actions: {
        echo: defineAction({
          id: "admission.echo",
          execute() {
            executions++;
            return "once";
          },
        }),
      },
      plugins: [
        definePlugin({
          ...serverPlugin,
          resources: { server: { default: defineTestServerFacade() } },
        }),
      ],
    });
    const submit = () =>
      app.fetch(
        new Request("http://test/api/actions/admission/echo", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "uncertain",
          },
          body: "{}",
        }),
      );
    try {
      const lost = await submit();
      assertEquals(lost.status, 503, await lost.clone().text());
      assertEquals(lost.headers.get("retry-after"), "3");
      if (reconnect) {
        await ready.promise;
        const replay = await submit();
        assertEquals(replay.status, 202, await replay.clone().text());
        const id = (await replay.json()).data.operationId;
        const result = await until(async () => {
          const response = await app.fetch(
            new Request(`http://test/api/operations/${id}/result`),
          );
          return response.status === 202 ? undefined : response;
        }, "authorized admission replay");
        assertEquals(result.status, 200, await result.clone().text());
        assertEquals((await result.json()).data, "once");
        assertEquals(executions, 1);
      } else {
        const unavailable = await submit();
        assertEquals(unavailable.status, 503);
        assertEquals(unavailable.headers.get("retry-after"), "3");
        assertEquals(
          (await unavailable.json()).error.code,
          "persistence_unavailable",
        );
      }
      assertEquals(generation, 2);
    } finally {
      await app.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}
