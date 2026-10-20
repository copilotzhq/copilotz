import { createTestApplication as createCopilotzApplication } from "../runtime/testing/server-authorization.test.ts";
import { defineTestServerFacade as fixtureServerFacade } from "../runtime/testing/server-authorization.test.ts";
import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "@copilotz/copilotz/actions";
import { definePlugin } from "@copilotz/copilotz/plugins";

import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { serverPlugin } from "../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { CopilotzHttpError, createCopilotzClient } from "../client/index.ts";

Deno.test("concurrent HTTP admission enforces the atomic cap and recovers identical receipts at capacity", async () => {
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
      defineFixturePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: fixtureServerFacade({
              authenticate: () => ({ actor: { id: "owner" } }),
              evaluate: () => ({ admission: { key: "conversation" } }),
              expose: { collections: false, channels: false },
            }),
          },
        },
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
    const admissions = await Promise.allSettled(
      Array.from(
        { length: 40 },
        (_, index) =>
          client.actions.submit("test.blocked", {}, {
            idempotencyKey: `key-${index}`,
          }),
      ),
    );
    const accepted = admissions.flatMap((result, index) =>
      result.status === "fulfilled" ? [{ index, receipt: result.value }] : []
    );
    assertEquals(accepted.length, 32);
    for (const result of admissions) {
      if (result.status === "rejected") {
        assertEquals(result.reason.code, "operation_replay_capacity_exceeded");
      }
    }
    ids.push(...accepted.map(({ receipt }) => receipt.operationId));
    const replayKey = `key-${accepted[0].index}`;
    assertEquals(
      (await client.actions.submit("test.blocked", {}, {
        idempotencyKey: replayKey,
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
          idempotencyKey: replayKey,
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
