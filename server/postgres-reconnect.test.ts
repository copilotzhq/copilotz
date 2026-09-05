import { assert, assertEquals } from "@std/assert";
import { type ActionContext, defineAction } from "../runtime/actions/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { createServerPlugin } from "../plugins/server/plugin.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { createCopilotzClient } from "../client/index.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

Deno.test({
  name:
    "PostgreSQL replays exact bytes across gateways, recovers lost receipts, and preserves retained Assets",
  ignore: !url,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const database = await createTestDatabase({ url: url! });
    const schema = `http_reconnect_${crypto.randomUUID().replaceAll("-", "")}`;
    const bytes = new TextEncoder().encode("hello 🌎");
    let release!: () => void;
    const finish = new Promise<void>((resolve) => release = resolve);
    let executions = 0;
    const plugins = [
      definePlugin({
        id: "test.reconnect",
        version: "1",
        actions: {
          stream: defineAction({
            id: "test.reconnect.stream",
            inputSchema: { type: "object" },
            async execute(_input: unknown, context: ActionContext) {
              executions++;
              const stream = await context.streams.open({
                mediaType: "text/plain",
                role: "content",
              });
              await stream.append({
                bytes: bytes.slice(0, 8),
                appendId: "prefix",
              });
              await finish;
              await stream.append({
                bytes: bytes.slice(8),
                appendId: "suffix",
              });
              const prepared = await stream.close({
                assetId: "retained-answer",
              });
              await context.content.materialize(prepared);
              await stream.retain({
                retention: "canonical",
                assetId: "retained-answer",
              });
              return "complete";
            },
          }),
        },
      }),
      createServerPlugin({ authenticate: () => ({ actor: { id: "owner" } }) }),
    ];
    const first = await createCopilotzApplication({
      database,
      databaseSchema: schema,
      namespace: "tenant",
      plugins,
    });
    const second = await createCopilotzApplication({
      database,
      databaseSchema: schema,
      namespace: "tenant",
      plugins,
    });
    const firstHandler = createServerFacadeFetchHandler(first);
    const secondHandler = createServerFacadeFetchHandler(second);
    let lost = false;
    const client = createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: (async (url, init) => {
        const response = await firstHandler(new Request(url, init));
        if (!lost && String(url).includes("/actions/")) {
          lost = true;
          await response.body?.cancel();
          throw new TypeError("receipt lost");
        }
        return response;
      }) as typeof fetch,
    });
    const reconnect = createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: ((url, init) =>
        secondHandler(new Request(url, init))) as typeof fetch,
    });
    try {
      const receipt = await client.actions.submit("test.reconnect.stream", {}, {
        idempotencyKey: "stable",
      });
      assertEquals(
        (await reconnect.actions.submit("test.reconnect.stream", {}, {
          idempotencyKey: "stable",
        })).operationId,
        receipt.operationId,
      );
      const collected: number[] = [];
      const connection = new AbortController();
      let applied!: () => void;
      const prefixApplied = new Promise<void>((resolve) => applied = resolve);
      let checkpoint: string | undefined;
      const observation = client.operations.observe({
        operationIds: [receipt.operationId],
        signal: connection.signal,
        onFrame(frame) {
          if (frame.kind === "stream-chunk") {
            collected.push(...frame.bytes);
            checkpoint = frame.checkpoint;
            applied();
          }
        },
      }).catch((error) => {
        if (!connection.signal.aborted) throw error;
      });
      await prefixApplied;
      connection.abort();
      await observation;
      assertEquals(collected, [...bytes.slice(0, 8)]);
      const status = await reconnect.operations.get(receipt.operationId) as {
        data: { state: string };
      };
      assert(["accepted", "running"].includes(status.data.state));
      release();
      await reconnect.operations.observe({
        operationIds: [receipt.operationId],
        checkpoint,
        onFrame(frame) {
          if (frame.kind === "stream-chunk") collected.push(...frame.bytes);
        },
      });
      assertEquals(collected, [...bytes]);
      assertEquals(
        await reconnect.operations.result(receipt.operationId),
        "complete",
      );
      assertEquals(executions, 1);
      const before = await database.query(
        `SELECT id, data FROM "${schema}".nodes WHERE type = 'asset' ORDER BY id`,
      );
      const stored = await reconnect.assets.get("retained-answer");
      assertEquals(new Uint8Array(await stored.arrayBuffer()), bytes);
      assertEquals(
        (await database.query(
          `SELECT id, data FROM "${schema}".nodes WHERE type = 'asset' ORDER BY id`,
        )).rows,
        before.rows,
      );
    } finally {
      release();
      await second.close();
      await first.close();
      await database.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.close();
    }
  },
});
