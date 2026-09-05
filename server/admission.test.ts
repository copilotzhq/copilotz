import { assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { createServerPlugin } from "../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { CopilotzHttpError, createCopilotzClient } from "../client/index.ts";

Deno.test("HTTP admission rejects a 33rd active operation but recovers identical receipts at capacity", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const application = await createCopilotzApplication({
    database,
    namespace: "tenant",
    plugins: [
      definePlugin({
        id: "test.admission",
        version: "1",
        actions: {
          blocked: defineAction({
            id: "test.blocked",
            inputSchema: { type: "object" },
            async execute() {
              await blocked;
              return "done";
            },
          }),
        },
      }),
      createServerPlugin({
        authenticate: () => ({ actor: { id: "owner" } }),
        authorize: () => ({ admission: { key: "conversation" } }),
        expose: { collections: false, channels: false },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  const ids: string[] = [];
  try {
    for (let index = 0; index < 32; index++) {
      ids.push(
        (await client.actions.submit("test.blocked", {}, {
          idempotencyKey: `key-${index}`,
        })).operationId,
      );
    }
    assertEquals(
      (await client.actions.submit("test.blocked", {}, {
        idempotencyKey: "key-0",
      })).operationId,
      ids[0],
    );
    const error = await assertRejects(
      () =>
        client.actions.submit("test.blocked", {}, {
          idempotencyKey: "overflow",
        }),
      CopilotzHttpError,
    );
    assertEquals(error.code, "operation_replay_capacity_exceeded");
    assertEquals(error.status, 409);
    const conflict = await assertRejects(
      () =>
        client.actions.submit("test.blocked", { different: true }, {
          idempotencyKey: "key-0",
        }),
      CopilotzHttpError,
    );
    assertEquals(conflict.code, "idempotency_conflict");
  } finally {
    release();
    await application.close();
    await database.close();
  }
});
