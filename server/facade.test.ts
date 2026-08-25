import { assert, assertEquals } from "@std/assert";
import { createCopilotz } from "../index.ts";
import {
  createSecretAdapter,
  defineAction,
  secret,
  type SecretAdapter,
} from "@copilotz/copilotz/actions";
import { defineCollection } from "@copilotz/copilotz/collections";
import { definePlugin } from "@copilotz/copilotz/plugins";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../runtime/events/index.ts";
import {
  createServerPlugin,
  type ServerEndpointDescriptor,
} from "../plugins/server/index.ts";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { decodeCopilotzOutputs } from "./multipart.ts";
import { base64ToBytes, bytesToBase64 } from "../runtime/content/index.ts";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function facadeSecretAdapter(): Promise<SecretAdapter> {
  const encryptionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const commitmentKey = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return createSecretAdapter({
    async seal({ plaintext, additionalAuthenticatedData }) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: arrayBuffer(iv),
            additionalData: arrayBuffer(additionalAuthenticatedData),
          },
          encryptionKey,
          arrayBuffer(plaintext),
        ),
      );
      const committed = new Uint8Array(
        additionalAuthenticatedData.byteLength + plaintext.byteLength,
      );
      committed.set(additionalAuthenticatedData);
      committed.set(plaintext, additionalAuthenticatedData.byteLength);
      return Object.freeze({
        ciphertext,
        commitment: bytesToBase64(
          new Uint8Array(
            await crypto.subtle.sign(
              "HMAC",
              commitmentKey,
              arrayBuffer(committed),
            ),
          ),
        ),
        envelope: Object.freeze({ iv: bytesToBase64(iv), keyVersion: "test" }),
      });
    },
    async open({ ciphertext, additionalAuthenticatedData, envelope }) {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: arrayBuffer(base64ToBytes(String(envelope.iv))),
            additionalData: arrayBuffer(additionalAuthenticatedData),
          },
          encryptionKey,
          arrayBuffer(ciphertext),
        ),
      );
    },
  });
}

const notes = defineCollection({
  name: "serverNotes",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
    },
    required: ["label"],
  } as const,
  queries: {
    byLabel: {
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      } as const,
      filter: ({ input }) => ({ label: input.label }),
    },
  },
  commands: {
    rename: {
      input: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      } as const,
      mutate: ({ input }) => ({
        set: { label: (input as { label: string }).label },
      }),
    },
  },
});

let echoExecutions = 0;

const echo = defineAction({
  id: "test.server.echo",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  } as const,
  outputSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
    additionalProperties: false,
  } as const,
  execute: (input: { value: string }) => {
    echoExecutions += 1;
    return { echoed: input.value };
  },
});

const SECRET_INPUT = "server-secret-input-7462";
const SECRET_OUTPUT = "server-secret-output-1839";
let protectedExecutions = 0;

const protectedEcho = defineAction({
  id: "test.server.protected-echo",
  inputSchema: {
    type: "object",
    properties: {
      label: { type: "string" },
      credential: secret({ type: "string" }),
    },
    required: ["label", "credential"],
    additionalProperties: false,
  } as const,
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      sessionToken: secret({ type: "string" }),
    },
    required: ["ok", "sessionToken"],
    additionalProperties: false,
  } as const,
  execute(input: Readonly<{ label: string; credential: string }>) {
    protectedExecutions++;
    assertEquals(input, { label: "protected", credential: SECRET_INPUT });
    return Object.freeze({ ok: true, sessionToken: SECRET_OUTPUT });
  },
});

const fixture = definePlugin({
  id: "test.server-facade",
  version: "1.0.0",
  actions: { echo },
  collections: { notes },
});

const protectedFixture = definePlugin({
  id: "test.server-facade-protected",
  version: "1.0.0",
  actions: { protectedEcho },
});

Deno.test("Server facade protects Action ingress and exposes plaintext only to direct JSON callers", async () => {
  const databaseSchema = "server_facade_protected_test";
  const database = await createTestDatabase({ url: ":memory:" });
  const executionsBefore = protectedExecutions;
  const application = await createCopilotzApplication({
    database,
    namespace: "tenant-a",
    databaseSchema,
    plugins: [
      protectedFixture,
      createServerPlugin({
        expose: {
          actions: { include: ["test.server.protected-echo"] },
          collections: false,
          channels: false,
        },
      }),
    ],
    adapters: { secrets: { default: await facadeSecretAdapter() } },
  });
  const fetch = createServerFacadeFetchHandler(application);
  const request = (
    idempotencyKey: string,
    accept = "application/json",
    credential = SECRET_INPUT,
  ) =>
    fetch(
      new Request(
        "https://example.test/api/v1/actions/test/server/protected-echo",
        {
          method: "POST",
          headers: {
            accept,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            label: "protected",
            credential,
          }),
        },
      ),
    );
  try {
    const direct = await request("protected-direct");
    assertEquals(direct.status, 200, await direct.clone().text());
    assertEquals(direct.headers.get("cache-control"), "no-store");
    assertEquals(await direct.json(), {
      data: { ok: true, sessionToken: SECRET_OUTPUT },
    });

    const replay = await request("protected-direct");
    assertEquals(replay.status, 200, await replay.clone().text());
    assertEquals(await replay.json(), {
      data: { ok: true, sessionToken: SECRET_OUTPUT },
    });
    assertEquals(protectedExecutions, executionsBefore + 1);

    const conflictSecret = `${SECRET_INPUT}-conflict`;
    const conflict = await request(
      "protected-direct",
      "application/json",
      conflictSecret,
    );
    assertEquals(conflict.status, 500);
    const conflictBody = await conflict.text();
    assertEquals(conflictBody.includes(SECRET_INPUT), false);
    assertEquals(conflictBody.includes(conflictSecret), false);
    assertEquals(protectedExecutions, executionsBefore + 1);

    const multipart = await request(
      "protected-multipart",
      "multipart/mixed",
    );
    assertEquals(multipart.status, 200);
    assertEquals(multipart.headers.get("cache-control"), "no-store");
    const outputs = [];
    for await (const output of decodeCopilotzOutputs(multipart)) {
      outputs.push(output);
    }
    const streamed = JSON.stringify(outputs);
    assertEquals(streamed.includes(SECRET_INPUT), false);
    assertEquals(streamed.includes(SECRET_OUTPUT), false);
    assertEquals(streamed.includes("$copilotz-secret"), true);

    const tables = createCoreTableNames(databaseSchema);
    const bodies = await database.query<{ body: unknown }>(
      `SELECT body FROM ${tables.event_bodies}`,
    );
    const nodes = await database.query<{ type: string; data: unknown }>(
      `SELECT type, data FROM ${tables.nodes}`,
    );
    const durable = JSON.stringify({ bodies: bodies.rows, nodes: nodes.rows });
    assertEquals(durable.includes(SECRET_INPUT), false);
    assertEquals(durable.includes(SECRET_OUTPUT), false);
    assertEquals(
      nodes.rows.filter((node) => node.type === "protected_value").length,
      6,
    );
    assertEquals(nodes.rows.some((node) => node.type === "asset"), false);
    const assetEvents = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${tables.events}
       WHERE type = 'asset.created'`,
    );
    assertEquals(Number(assetEvents.rows[0]?.count), 0);
  } finally {
    await application.close("server_facade_protected_done");
    await database.close();
  }
});

Deno.test("Server facade executes Actions and Collections through one guarded route table", async () => {
  const observed: ServerEndpointDescriptor[] = [];
  const executionsBefore = echoExecutions;
  const application = await createCopilotzApplication({
    namespace: "tenant-a",
    databaseSchema: "server_facade_test",
    plugins: [
      fixture,
      createServerPlugin({
        expose: {
          actions: { include: ["test.server.*"] },
          collections: { include: ["serverNotes"] },
          channels: false,
        },
        guard(_request, context) {
          observed.push(context.endpoint);
          return { namespace: "tenant-a" };
        },
      }),
    ],
  });
  const fetch = createServerFacadeFetchHandler(application);
  try {
    const action = await fetch(
      new Request(
        "https://example.test/api/v1/actions/test/server/echo",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "server-echo-a",
          },
          body: JSON.stringify({ value: "hello" }),
        },
      ),
    );
    assertEquals(action.status, 200);
    assertEquals(await action.json(), { data: { echoed: "hello" } });

    const replayedAction = await fetch(
      new Request(
        "https://example.test/api/v1/actions/test/server/echo",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "server-echo-a",
          },
          body: JSON.stringify({ value: "hello" }),
        },
      ),
    );
    assertEquals(replayedAction.status, 200);
    assertEquals(await replayedAction.json(), { data: { echoed: "hello" } });
    assertEquals(echoExecutions, executionsBefore + 1);

    const created = await fetch(
      new Request(
        "https://example.test/api/v1/collections/serverNotes",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "server-note-a",
          },
          body: JSON.stringify({ id: "note-a", label: "hello" }),
        },
      ),
    );
    const createdBody = await created.json();
    assertEquals(created.status, 201, JSON.stringify(createdBody));
    assertEquals(createdBody.data.label, "hello");

    const queried = await fetch(
      new Request(
        "https://example.test/api/v1/collections/serverNotes/queries/byLabel",
        {
          method: "QUERY",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "hello" }),
        },
      ),
    );
    assertEquals(queried.status, 200);
    assertEquals((await queried.json()).data.length, 1);
    assertEquals(observed.map((endpoint) => endpoint.kind), [
      "action",
      "action",
      "collection",
      "collection",
    ]);

    const openApi = await fetch(
      new Request("https://example.test/api/v1/openapi.json"),
    );
    assertEquals(openApi.status, 200);
    assertEquals((await openApi.json()).data.openapi, "3.2.0");
  } finally {
    await application.close("server_facade_test_done");
  }
});

Deno.test("Server facade guard may terminate and multipart observes one Action scope", async () => {
  let trustedContext: Readonly<Record<string, unknown>> | undefined;
  const application = await createCopilotzApplication({
    namespace: "tenant-a",
    databaseSchema: "server_facade_stream_test",
    plugins: [
      fixture,
      createServerPlugin({
        guard(request, context) {
          trustedContext = context.requestContext;
          if (request.headers.get("authorization") !== "Bearer test") {
            return Response.json({ error: { code: "unauthorized" } }, {
              status: 401,
            });
          }
        },
      }),
    ],
  });
  const fetch = createServerFacadeFetchHandler(application, {
    resolveContext: () => Object.freeze({ tenantId: "tenant-a" }),
  });
  try {
    const denied = await fetch(
      new Request(
        "https://example.test/api/v1/actions/test/server/echo",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: "denied" }),
        },
      ),
    );
    assertEquals(denied.status, 401);

    const response = await fetch(
      new Request(
        "https://example.test/api/v1/actions/test/server/echo",
        {
          method: "POST",
          headers: {
            accept: "multipart/mixed",
            authorization: "Bearer test",
            "content-type": "application/json",
            "idempotency-key": "server-multipart-a",
          },
          body: JSON.stringify({ value: "streamed" }),
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(trustedContext, { tenantId: "tenant-a" });
    const outputs = [];
    for await (const output of decodeCopilotzOutputs(response)) {
      outputs.push(output);
    }
    assert(
      outputs.some((output) => output.type === "test.server.echo.completed"),
    );
    assert(
      outputs.some((output) =>
        output.type === "copilotz.server.internal.invoke.completed"
      ),
    );
  } finally {
    await application.close("server_facade_stream_test_done");
  }
});

Deno.test("Server facade preserves guard-selected schema and path-owned command id", async () => {
  const tenantSchema = "server_facade_guard_tenant";
  const database = await createTestDatabase({ url: ":memory:" });
  await provisionCopilotzSchema(database, tenantSchema);
  const application = await createCopilotzApplication({
    namespace: "tenant-a",
    databaseSchema: "server_facade_guard_default",
    plugins: [
      fixture,
      createServerPlugin({
        expose: { actions: false, channels: false },
        guard: () => ({
          namespace: "tenant-a",
          databaseSchema: tenantSchema,
        }),
      }),
    ],
    database,
  });
  const fetch = createServerFacadeFetchHandler(application);
  const request = (path: string, init: RequestInit = {}) =>
    fetch(new Request(`https://example.test/api/v1${path}`, init));
  try {
    for (const [id, label] of [["note-a", "A"], ["note-b", "B"]]) {
      const response = await request("/collections/serverNotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, label }),
      });
      assertEquals(response.status, 201, await response.clone().text());
    }
    const renamed = await request(
      "/collections/serverNotes/note-a/commands/rename",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "note-b", label: "renamed" }),
      },
    );
    assertEquals(renamed.status, 200);
    assertEquals((await renamed.json()).data.id, "note-a");
    assertEquals(
      (await (await request("/collections/serverNotes/note-a")).json()).data
        .label,
      "renamed",
    );
    assertEquals(
      (await (await request("/collections/serverNotes/note-b")).json()).data
        .label,
      "B",
    );

    const defaultRecords = await application.collections.withScope({
      namespace: "tenant-a",
    }).serverNotes.list();
    const tenant = await application.databaseScope(tenantSchema);
    const tenantRecords = await tenant.collections.withScope({
      namespace: "tenant-a",
    }).serverNotes.list();
    assertEquals(defaultRecords.length, 0);
    assertEquals(tenantRecords.length, 2);
  } finally {
    await application.close("server_facade_guard_schema_done");
    await database.close();
  }
});

Deno.test("Gateway mounts the composed facade in Oxian-compatible Fetch while retaining v3", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const workerId = `server-facade-worker-${crypto.randomUUID()}`;
  const transport = Object.freeze({
    type: "in-process" as const,
    config: Object.freeze({ topic: `server.facade.${crypto.randomUUID()}` }),
  });
  const plugins = [fixture, createServerPlugin()] as const;
  const gateway = await createCopilotz({
    role: "gateway",
    database,
    namespace: "tenant-a",
    databaseSchema: "server_gateway_test",
    plugins,
    transports: [transport],
    target: { workerId },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  const worker = await createCopilotz({
    role: "worker",
    database,
    namespace: "tenant-a",
    databaseSchema: "server_gateway_test",
    plugins,
    id: workerId,
    transport,
    capacity: 4,
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    await worker.ready;
    const response = await gateway.fetch(
      new Request(
        "https://example.test/api/v1/actions/test/server/echo",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "gateway-server-echo",
          },
          body: JSON.stringify({ value: "gateway" }),
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { data: { echoed: "gateway" } });
    const legacy = await gateway.fetch(
      new Request("https://example.test/v3/agents"),
    );
    assertEquals(legacy.status, 200);
  } finally {
    await Promise.allSettled([
      gateway.close("server_gateway_test_done"),
      worker.close("server_gateway_test_done"),
    ]);
    await database.close();
  }
});
