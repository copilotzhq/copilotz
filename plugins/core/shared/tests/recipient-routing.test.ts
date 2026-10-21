import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { assert, assertEquals } from "@std/assert";
import { createCopilotz } from "../../../../index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { testSecretAdapter } from "../../../../runtime/testing/secret-adapter.ts";
import { testAuthority } from "../../../../runtime/testing/authority.ts";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { defineAction } from "@copilotz/copilotz/actions";
import { corePlugin, defineAgent, message } from "@copilotz/copilotz/core";
import { serverPlugin } from "../../../server/plugin.ts";
import { defineServerFacade } from "../../../server/resources/facade/index.ts";
import { createCopilotzClient } from "../../../../client/index.ts";

async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgliteExtensions: ["vector"],
  });
  const schema = `recipient_${crypto.randomUUID().replaceAll("-", "")}`;
  const namespace = "chat";
  let calls = 0;
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
    engine: { retryBaseMs: 0, random: () => 0 },
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
            assistant: defineAgent({
              id: "assistant",
              name: "Assistant",
              role: "assistant",
              models: { generate: [{ connection: "offline", model: "test" }] },
            }),
          },
          llmConnections: { offline: { adapter: "offline" } },
        },
        adapters: {
          secrets: { default: await testSecretAdapter() },
          llm: {
            offline: {
              call() {
                calls++;
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
    async settled() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const deliveries =
          (await db.query<{ status: string; last_error: unknown }>(
            `SELECT status,last_error FROM "${schema}".event_deliveries`,
          )).rows;
        assert(
          !deliveries.some((row) => row.status === "dead_letter"),
          JSON.stringify(deliveries),
        );
        if (
          deliveries.length &&
          deliveries.every((row) =>
            ["succeeded", "cancelled"].includes(row.status)
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
const sender = {
  id: "sender",
  externalId: "sender",
  participantType: "human" as const,
};
const human = {
  id: "human",
  externalId: "human",
  participantType: "human" as const,
};
const agent = {
  id: "agent",
  externalId: "assistant",
  participantType: "agent" as const,
  agentId: "assistant",
};

for (const recipientIds of [["human"], ["agent"], ["human", "agent"]]) {
  Deno.test(`explicit ${recipientIds.join("+")} recipients settle via creation and message input`, async () => {
    const f = await fixture();
    await f.invoke("login", {});
    try {
      await f.invoke("createThread", {
        id: "thread",
        participants: [sender, human, agent],
      });
      await f.invoke("createThreadMessage", {
        id: "direct",
        threadId: "thread",
        sender,
        recipientIds,
        content: "Direct message",
      });
      await f.settled();
      const sent = await f.app.send(
        message({
          thread: { id: "thread" },
          participant: sender,
          recipientIds,
          content: "Input message",
        }),
      );
      await sent.done;
      await f.settled();
      const messages = await f.records("message");
      const inputs = messages.filter((item) => item.senderId === "sender");
      assertEquals(inputs.length, 2);
      for (const input of inputs) {
        assertEquals(input.recipientIds, recipientIds);
      }
      const expected = recipientIds.includes("agent") ? 2 : 0;
      assertEquals(f.calls, expected);
      assertEquals(
        messages.filter((item) => item.senderId === "agent").length,
        expected,
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test("native-session first chat with owner policies closes snapshots and stores the Agent reply", async () => {
  const f = await fixture();
  try {
    await f.invoke("login", {});
    assert(f.cookie);
    assertEquals(await f.records("participant"), []);
    await f.invoke("createThread", {
      id: "thread",
      participants: [sender, agent],
    });
    await f.invoke("createThreadMessage", {
      id: "first",
      threadId: "thread",
      sender,
      recipientIds: ["agent"],
      content: "First question",
    });
    await f.settled();
    assertEquals(f.calls, 1);
    const replies = (await f.records("message")).filter((item) =>
      item.senderId === "agent"
    );
    assertEquals(replies.length, 1);
    // A second turn also proves the first snapshot released its physical capacity.
    await f.invoke("createThreadMessage", {
      id: "second",
      threadId: "thread",
      sender,
      recipientIds: ["agent"],
      content: "Second question",
    });
    await f.settled();
    assertEquals(f.calls, 2);
  } finally {
    await f.close();
  }
});
