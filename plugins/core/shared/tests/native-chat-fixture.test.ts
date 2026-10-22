import {
  eventDataRef,
  readEventBody,
} from "../../../../runtime/events/body-store.ts";
import { createCoreTableNames } from "../../../../runtime/events/schema.ts";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { assert } from "@std/assert";
import { createCopilotz } from "../../../../index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { testSecretAdapter } from "../../../../runtime/testing/secret-adapter.ts";
import { testAuthority } from "../../../../runtime/testing/authority.ts";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { defineAction } from "@copilotz/copilotz/actions";
import { corePlugin, defineAgent } from "@copilotz/copilotz/core";
import { serverPlugin } from "../../../server/plugin.ts";
import { defineServerFacade } from "../../../server/resources/facade/index.ts";
import { createCopilotzClient } from "../../../../client/index.ts";

export async function nativeChatFixture(options: {
  provider?: (
    call: number,
    input: import("../../../llm/shared/contracts.ts").LlmAdapterCallInput,
  ) => import("../../../llm/shared/contracts.ts").LlmInvocation;
  missingFallback?: boolean;
  peerAgent?: boolean;
} = {}) {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgliteExtensions: ["vector"],
  });
  const schema = `recipient_${crypto.randomUUID().replaceAll("-", "")}`;
  const namespace = "chat";
  let calls = 0;
  const readableAssets = new Set<string>();
  const login = defineAction({
    id: "test.chat-login",
    async execute(_input, ctx) {
      await ctx.transaction(async (tx) => {
        await tx.sessions.create({ principal: "reader", maxAge: 3600 });
      });
      return { ok: true };
    },
  });
  const registry = createPluginRegistry({
    plugins: [corePlugin],
    actions: { login },
  });
  const references = (names: readonly string[]) =>
    Object.fromEntries(
      names.map((name) => [name, { id: "fixture", revision: "1" }]),
    );
  const config = {
    database: db,
    databaseSchema: schema,
    namespace,
    engine: { retryBaseMs: 20, random: () => 1 },
    authorization: {
      systemScopes: { [namespace]: testAuthority(schema, namespace).scope },
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate() {
            return {
              actions: Object.fromEntries(
                Object.keys(registry.actions).map((id) => [id, {}]),
              ),
              collections: Object.fromEntries(
                Object.keys(registry.collections).map((id) => [id, {}]),
              ),
              collectionMutations: Object.fromEntries(
                Object.entries(registry.collections).map((
                  [id, collection],
                ) => [id, {
                  create: {},
                  update: {},
                  delete: {},
                  commands: Object.fromEntries(
                    Object.keys(collection.commands ?? {}).map((
                      command,
                    ) => [command, {}]),
                  ),
                }]),
              ),
              assets: { read: [...readableAssets] },
              operations: { metadata: {} },
              sessions: { create: { principal: "reader", maxAge: 3600 } },
            };
          },
        },
      },
      actions: references(Object.keys(registry.actions)),
      collections: references(Object.keys(registry.collections)),
    },
    plugins: [
      corePlugin,
      definePlugin({
        id: "test.recipient-routing",
        version: "1",
        actions: { login },
        resources: {
          agents: {
            ...(options.peerAgent
              ? {
                peer: defineAgent({
                  id: "peer",
                  name: "Peer",
                  role: "assistant",
                  models: {
                    generate: [{ connection: "offline", model: "peer" }],
                  },
                }),
              }
              : {}),
            assistant: defineAgent({
              id: "assistant",
              name: "Assistant",
              role: "assistant",
              models: {
                generate: [
                  { connection: "offline", model: "test" },
                  ...(options.missingFallback
                    ? [{ connection: "missing", model: "test" }]
                    : []),
                ],
              },
            }),
          },
          llmConnections: {
            offline: { adapter: "offline" },
            ...(options.missingFallback
              ? {
                missing: {
                  provider: "openai" as const,
                  auth: { resolve: () => ({ available: false as const }) },
                },
              }
              : {}),
          },
        },
        adapters: {
          secrets: { default: await testSecretAdapter() },
          llm: {
            offline: {
              call(
                input:
                  import("../../../llm/shared/contracts.ts").LlmAdapterCallInput,
              ) {
                calls++;
                if (options.provider) return options.provider(calls, input);
                return {
                  frames: new ReadableStream({
                    start(controller) {
                      controller.close();
                    },
                  }),
                  result: Promise.resolve({
                    content: "Full first reply",
                    attempts: [{ status: "completed" as const }],
                    finishReason: "stop",
                  }),
                };
              },
            },
          },
        },
      }),
      definePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: defineServerFacade({
              authenticate: () => ({
                authority: testAuthority(schema, namespace),
                actor: { id: "reader" },
              }),
              expose: { actions: true, collections: true, channels: false },
            }),
          },
        },
      }),
    ],
  } as const;
  const transport = {
    type: "in-process",
    config: { topic: crypto.randomUUID() },
  } as const;
  const app = await createCopilotz({
    ...config,
    role: "gateway",
    transports: [transport],
    target: { workerId: "worker" },
  });
  const worker = await createCopilotz({
    role: "worker",
    namespace,
    databaseSchema: schema,
    plugins: config.plugins,
    id: "worker",
    transport,
  });
  await worker.ready;
  const handler = (request: Request) => app.fetch(request);
  let cookie = "";
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set("cookie", cookie);
      const response = await handler!(new Request(input, { ...init, headers }));
      const next = response.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      return response;
    },
  });
  const invoke = (action: string, input: unknown) =>
    client.actions.invoke(action, input, {
      idempotencyKey: crypto.randomUUID(),
      signal: AbortSignal.timeout(30_000),
    });
  return {
    app,
    async events(type: string) {
      const rows = (await db.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM "${schema}".events WHERE type=$1 ORDER BY position`,
        [type],
      )).rows;
      return await Promise.all(rows.map(async (row) => {
        const body = await readEventBody<Record<string, unknown>>(
          { transaction: db, tables: createCoreTableNames(schema) },
          namespace,
          eventDataRef(row.payload),
        );
        return { payload: (body.data ?? body) as Record<string, unknown> };
      }));
    },
    async text(message: CollectionRecord) {
      const content = message.content as { assetId: string }[];
      for (const ref of content) readableAssets.add(ref.assetId);
      return (await Promise.all(
        content.map(async (ref) =>
          (await client.assets.get(ref.assetId)).text()
        ),
      )).join("");
    },
    async deliveries() {
      return (await db.query<
        { status: string; attempts: number; last_error: unknown }
      >(
        `SELECT status,attempts,last_error FROM "${schema}".event_deliveries WHERE consumer_id='processor:copilotz.core.message-to-llm-call' ORDER BY attempts DESC`,
      )).rows;
    },
    async records(alias: string) {
      const page = await client.collections.list(alias, { limit: 100 }) as {
        data: CollectionRecord[];
      };
      return page.data;
    },
    invoke,
    get calls() {
      return calls;
    },
    get cookie() {
      return cookie;
    },
    async settled(allowDeadLetter = false) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const deliveries =
          (await db.query<{ status: string; last_error: unknown }>(
            `SELECT status,last_error FROM "${schema}".event_deliveries`,
          )).rows;
        assert(
          allowDeadLetter ||
            !deliveries.some((row) => row.status === "dead_letter"),
          JSON.stringify(deliveries),
        );
        if (
          deliveries.length &&
          deliveries.every((row) =>
            [
              "succeeded",
              "cancelled",
              ...(allowDeadLetter ? ["dead_letter"] : []),
            ].includes(row.status)
          )
        ) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Background deliveries did not settle");
    },
    async close() {
      await worker.close();
      await app.close();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    },
  };
}
