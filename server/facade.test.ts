import { assert, assertEquals, assertRejects } from "@std/assert";
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
import { CopilotzHttpError, createCopilotzClient } from "../client/index.ts";
import { base64ToBytes, bytesToBase64 } from "../runtime/content/index.ts";
import { provisionOperationCatalog } from "../runtime/streams/index.ts";

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

function browser(
  handler: (request: Request) => Promise<Response>,
  headers?: HeadersInit,
) {
  return createCopilotzClient({
    baseUrl: "https://test/api",
    getRequestHeaders: () => headers ?? {},
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
}

Deno.test("Server facade protects durable secrets and restricts plaintext to authorized result reads", async () => {
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
        authenticate(request) {
          return { actor: { id: request.headers.get("x-user") ?? "owner" } };
        },
        authorize(_request, context) {
          return {
            operations: { metadata: { actorId: context.scope.actor!.id } },
          };
        },
        expose: {
          actions: { include: ["test.server.protected-echo"] },
          collections: false,
          channels: false,
        },
      }),
    ],
    adapters: { secrets: { default: await facadeSecretAdapter() } },
  });
  const handler = createServerFacadeFetchHandler(application);
  const client = browser(handler);
  try {
    const input = { label: "protected", credential: SECRET_INPUT };
    const first = await client.actions.submit(
      "test.server.protected-echo",
      input,
      { idempotencyKey: "secret" },
    );
    assertEquals(await client.operations.result(first.operationId), {
      ok: true,
      sessionToken: SECRET_OUTPUT,
    });
    const repeated = await client.actions.submit(
      "test.server.protected-echo",
      input,
      { idempotencyKey: "secret" },
    );
    assertEquals(repeated.operationId, first.operationId);
    assertEquals(protectedExecutions, executionsBefore + 1);
    await assertRejects(
      () =>
        client.actions.submit("test.server.protected-echo", {
          ...input,
          credential: "changed",
        }, { idempotencyKey: "secret" }),
      CopilotzHttpError,
    );
    await assertRejects(
      () =>
        browser(handler, { "x-user": "outsider" }).operations.result(
          first.operationId,
        ),
      CopilotzHttpError,
    );
    const response = await handler(
      new Request(`https://test/api/operations/${first.operationId}/result`),
    );
    assertEquals(response.headers.get("cache-control"), "no-store");
    const frames: unknown[] = [];
    await client.operations.observe({
      operationIds: [first.operationId],
      onFrame(frame) {
        frames.push(frame);
      },
    });
    const streamed = JSON.stringify(frames);
    assertEquals(streamed.includes(SECRET_INPUT), false);
    assertEquals(streamed.includes(SECRET_OUTPUT), false);
    assertEquals(streamed.includes("$copilotz-secret"), true);
    const tables = createCoreTableNames(databaseSchema);
    const bodies = await database.query(
      `SELECT body FROM ${tables.event_bodies}`,
    );
    const nodes = await database.query(
      `SELECT type, data FROM ${tables.nodes}`,
    );
    const durable = JSON.stringify({ bodies: bodies.rows, nodes: nodes.rows });
    assertEquals(durable.includes(SECRET_INPUT), false);
    assertEquals(durable.includes(SECRET_OUTPUT), false);
  } finally {
    await application.close();
    await database.close();
  }
});

Deno.test("authorization predicates intersect requested collection filters before pagination", async () => {
  const endpoints: ServerEndpointDescriptor[] = [];
  const application = await createCopilotzApplication({
    namespace: "tenant-a",
    databaseSchema: "server_policy_test",
    plugins: [
      fixture,
      createServerPlugin({
        authenticate(_request, context) {
          endpoints.push(context.endpoint);
          return { namespace: "tenant-a" };
        },
        authorize(_request, context) {
          return context.endpoint.kind === "collection"
            ? { collections: { serverNotes: { where: { label: "allowed" } } } }
            : { input: { value: "allowed" } };
        },
        expose: {
          actions: { include: ["test.server.*"] },
          collections: { include: ["serverNotes"] },
          channels: false,
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  const client = browser(handler);
  try {
    const notes =
      application.collections.withScope({ namespace: "tenant-a" }).serverNotes;
    const invalidQuery = await assertRejects(
      () => client.collections.query("serverNotes", "byLabel", { label: 42 }),
      CopilotzHttpError,
    );
    assertEquals(invalidQuery.status, 400);
    assertEquals(invalidQuery.code, "invalid_input");
    for (
      const [id, label] of [
        ["a", "hidden"],
        ["b", "allowed"],
        ["c", "hidden"],
        ["d", "allowed"],
      ]
    ) await notes.create({ id, label });
    const page = await client.collections.list("serverNotes", {
      limit: 1,
      order: "asc",
    }) as { data: { id: string }[] };
    assertEquals(page.data.map((value) => value.id), ["b"]);
    const next = await client.collections.list("serverNotes", {
      limit: 1,
      order: "asc",
      after: "b",
    }) as { data: { id: string }[] };
    assertEquals(next.data.map((value) => value.id), ["d"]);
    const conflict = await client.collections.list("serverNotes", {
      where: { label: "hidden" },
    }) as { data: unknown[] };
    assertEquals(conflict.data, []);
    await assertRejects(
      () => client.collections.get("serverNotes", "a"),
      CopilotzHttpError,
    );
    assertEquals(
      await client.actions.invoke("test.server.echo", {}, {
        idempotencyKey: "enforced",
      }),
      { echoed: "allowed" },
    );
    await assertRejects(
      () =>
        client.actions.submit("test.server.echo", { value: "forged" }, {
          idempotencyKey: "forged",
        }),
      CopilotzHttpError,
    );
    assert(endpoints.some((value) => value.kind === "action"));
    assert(endpoints.some((value) => value.kind === "collection"));
  } finally {
    await application.close();
  }
});

Deno.test("authentication chooses the database scope and can return an early HTTP response", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const schema = "server_authenticated_tenant";
  await provisionCopilotzSchema(database, schema);
  await provisionOperationCatalog(database, schema);
  const application = await createCopilotzApplication({
    database,
    namespace: "tenant-a",
    databaseSchema: "server_authenticated_default",
    plugins: [
      fixture,
      createServerPlugin({
        authenticate(request, context) {
          assertEquals(context.endpoint.kind, "collection");
          return request.headers.has("authorization")
            ? { namespace: "tenant-a", databaseSchema: schema }
            : new Response(null, { status: 401 });
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  try {
    const tenant = await application.databaseScope(schema);
    await tenant.collections.withScope({ namespace: "tenant-a" }).serverNotes
      .create({
        id: "same",
        label: "tenant",
      });
    await application.collections.withScope({ namespace: "tenant-a" })
      .serverNotes
      .create({ id: "same", label: "default" });
    const client = browser(handler, {
      authorization: "Bearer test",
      "x-database-schema": "server_authenticated_default",
    });
    assertEquals(
      (await client.collections.get("serverNotes", "same") as {
        data: { label: string };
      }).data.label,
      "tenant",
    );
    await assertRejects(
      () => browser(handler).collections.get("serverNotes", "same"),
      CopilotzHttpError,
    );
  } finally {
    await application.close();
    await database.close();
  }
});

Deno.test("Server facade publishes raw asset uploads without Action payload copies", async () => {
  const seen: ServerEndpointDescriptor[] = [];
  const application = await createCopilotzApplication({
    namespace: "tenant-a",
    databaseSchema: "server_facade_asset_upload",
    plugins: [
      createServerPlugin({
        maxAssetUploadBytes: 4,
        authenticate(_request, context) {
          seen.push(context.endpoint);
          return { namespace: "tenant-a" };
        },
      }),
    ],
  });
  const fetch = createServerFacadeFetchHandler(application);
  const upload = () =>
    fetch(
      new Request("https://example.test/api/assets", {
        method: "POST",
        headers: {
          // The body is intentionally invalid JSON: asset upload treats declared
          // media as metadata and consumes raw bytes rather than JSON-decoding it.
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="notes.txt"',
          "idempotency-key": "server-asset-upload-a",
        },
        body: new TextEncoder().encode("test"),
      }),
    );
  try {
    const first = await upload();
    assertEquals(first.status, 201, await first.clone().text());
    const firstBody = await first.json();
    assertEquals(firstBody.data.content, {
      assetId: firstBody.data.asset.id,
      kind: "file",
      role: "attachment",
      mediaType: "application/json",
      disposition: "attachment",
      name: "notes.txt",
    });
    assertEquals(firstBody.data.asset.metadata, { name: "notes.txt" });
    assertEquals(firstBody.data.asset.location, undefined);
    assertEquals(
      firstBody.data.assetRef,
      `asset://tenant-a/${firstBody.data.asset.id}`,
    );

    const replay = await upload();
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals((await replay.json()).data.asset.id, firstBody.data.asset.id);

    const noBody = await fetch(
      new Request("https://example.test/api/assets", {
        method: "POST",
        headers: { "idempotency-key": "server-asset-upload-empty" },
      }),
    );
    assertEquals(noBody.status, 400);
    assertEquals((await noBody.json()).error.code, "asset_body_required");

    let cancelledOversizedBody = false;
    const oversized = await fetch(
      new Request("https://example.test/api/assets", {
        method: "POST",
        headers: { "idempotency-key": "server-asset-upload-large" },
        // No Content-Length: the Fetch boundary must enforce the cap while
        // consuming a chunked/streamed body, before buffering all of it.
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("larg"));
            controller.enqueue(new TextEncoder().encode("e"));
          },
          cancel() {
            cancelledOversizedBody = true;
          },
        }),
      }),
    );
    assertEquals(oversized.status, 413);
    assertEquals((await oversized.json()).error.code, "asset_too_large");
    assertEquals(cancelledOversizedBody, true);
    assertEquals(seen.map((endpoint) => endpoint.operation), [
      "upload",
      "upload",
      "upload",
      "upload",
    ]);
  } finally {
    await application.close("server_facade_asset_upload_done");
  }
});

Deno.test("Gateway mounts the composed facade in Oxian-compatible Fetch and rejects retired routes", async () => {
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
        "https://example.test/api/actions/test/server/echo",
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
    assertEquals(response.status, 202);
    const client = createCopilotzClient({
      baseUrl: "https://example.test/api",
      fetch: ((url, init) =>
        gateway.fetch(new Request(url, init))) as typeof fetch,
    });
    assertEquals(
      await client.operations.result((await response.json()).data.operationId),
      { echoed: "gateway" },
    );
    const legacy = await gateway.fetch(
      new Request("https://example.test/v3/agents"),
    );
    assertEquals(legacy.status, 404);
  } finally {
    await Promise.allSettled([
      gateway.close("server_gateway_test_done"),
      worker.close("server_gateway_test_done"),
    ]);
    await database.close();
  }
});
