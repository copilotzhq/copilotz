import { defineServerFacade as fixtureServerFacade } from "@copilotz/copilotz/server";
import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assert, assertEquals } from "@std/assert";
import { type ActionContext, defineAction } from "../runtime/actions/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { encodeOperationReplayCursor } from "../runtime/streams/cursor.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import {
  createCopilotzClient,
  type ObservationFrame,
} from "../client/index.ts";

Deno.test("replay retains a stream's source Action context when invocation precedes the checkpoint", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  let release!: () => void;
  const finish = new Promise<void>((resolve) => release = resolve);
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => opened = resolve);
  const application = await createCopilotzApplication({
    database,
    namespace: "origin-test",
    plugins: [
      definePlugin({
        id: "origin-test",
        version: "1",
        actions: {
          stream: defineAction({
            id: "test.origin.stream",
            inputSchema: { type: "object" },
            async execute(_input: unknown, context: ActionContext) {
              const stream = await context.streams.open({
                mediaType: "text/plain",
                role: "tool-output",
              });
              await stream.append({
                bytes: new TextEncoder().encode("progress"),
                appendId: "one",
              });
              opened();
              await finish;
              await stream.close({ assetId: "retained-progress" });
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
              authenticate: () => ({
                actor: { id: "owner" },
                actionMetadata: {
                  copilotzToolAction: {
                    planMessageId: "plan",
                    toolCallId: "reused-provider-id",
                  },
                },
              }),
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
  try {
    const receipt = await client.actions.submit("test.origin.stream", {}, {
      idempotencyKey: "origin",
    });
    await ready;
    const events = await application.events.list({
      namespace: "origin-test",
      limit: 1000,
    });
    const invocation = events.find((event) =>
      event.type === "test.origin.stream.invoked"
    )!;
    assert(invocation);
    const checkpoint = encodeOperationReplayCursor({
      eventPosition: events.at(-1)!.position,
    });
    const frames: ObservationFrame[] = [];
    await client.operations.observe({
      operationIds: [receipt.operationId],
      checkpoint,
      onFrame(frame) {
        frames.push(frame);
        if (frame.kind === "stream-chunk") release();
      },
    });
    const descriptor = frames.find((frame) =>
      frame.kind === "output" && frame.output.type === "stream.output"
    );
    assert(descriptor?.kind === "output");
    const metadata = descriptor.output.metadata as Record<string, unknown>;
    const source = metadata.sourceAction as {
      actionRunId: string;
      metadata: Record<string, unknown>;
    };
    assertEquals(source.actionRunId, metadata.sourceActionRunId);
    assertEquals(source.metadata.copilotzToolAction, {
      planMessageId: "plan",
      toolCallId: "reused-provider-id",
    });
    assert(
      !frames.some((frame) =>
        frame.kind === "output" && frame.output.id === invocation.id
      ),
    );
    assertEquals(await client.operations.result(receipt.operationId), "done");
  } finally {
    release();
    await application.close();
    await database.close();
  }
});

Deno.test("stream origin cache remains bounded without limiting a long run's Action count", async () => {
  const { createStreamOriginResolver } = await import("./stream-origin.ts");
  type Runtime = Parameters<typeof createStreamOriginResolver>[0];
  let reads = 0;
  const runtime = {
    operations: {
      findEventId: ({ operationId }: { operationId: string }) =>
        Promise.resolve(operationId),
    },
    events: {
      resolve: (_namespace: string, id: string) => {
        reads++;
        return Promise.resolve({
          data: { actionRunId: id, metadata: { safe: true } },
        });
      },
    },
  } as unknown as Runtime;
  const resolve = createStreamOriginResolver(
    runtime,
    "tenant",
    new AbortController().signal,
  );
  for (let index = 0; index <= 300; index++) {
    const run = index === 300 ? "run-0" : `run-${index}`;
    const stream = {
      metadata: { sourceActionRunId: run },
    } as unknown as Parameters<
      typeof resolve
    >[1];
    assertEquals((await resolve(run, stream)).metadata.sourceAction, {
      actionRunId: run,
      metadata: { safe: true },
    });
  }
  assertEquals(reads, 301);
});

Deno.test("cold stream origin resolution uses canonical public data and counts every SQL read", async () => {
  const { createStreamOriginResolver } = await import("./stream-origin.ts");
  const { createSecretAdapter, secret } = await import(
    "../runtime/actions/index.ts"
  );
  const { defineProcessor } = await import("../runtime/plugins/index.ts");
  const db = await createTestDatabase({ url: ":memory:" });
  const namespace = "cold-origin";
  const schema = "cold_origin";
  const executed: string[] = [];
  const query: import("../runtime/events/index.ts").SqlExecutor["query"] = (
    sql,
    params,
  ) => {
    executed.push(sql);
    return db.query(sql, params);
  };
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
  const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;
  let decryptions = 0;
  const adapter = createSecretAdapter({
    async seal({ plaintext, additionalAuthenticatedData }) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: buffer(iv),
            additionalData: buffer(additionalAuthenticatedData),
          },
          encryptionKey,
          buffer(plaintext),
        ),
      );
      const commitment = new Uint8Array(
        await crypto.subtle.sign("HMAC", commitmentKey, buffer(plaintext)),
      );
      return {
        ciphertext,
        commitment: [...commitment].join("-"),
        envelope: { iv: [...iv] },
      };
    },
    async open({ ciphertext, additionalAuthenticatedData, envelope }) {
      decryptions++;
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(envelope.iv as number[]),
            additionalData: buffer(additionalAuthenticatedData),
          },
          encryptionKey,
          buffer(ciphertext),
        ),
      );
    },
  });
  const plugin = definePlugin({
    id: "cold-origin-plugin",
    version: "1",
    actions: {
      protected: defineAction({
        id: "test.cold-origin",
        inputSchema: {
          type: "object",
          properties: { token: secret({ type: "string" }) },
          required: ["token"],
        } as const,
        execute(input: { token: string }) {
          assertEquals(input.token, "secret-origin-needle");
          return "done";
        },
      }),
    },
    processors: {
      invoke: defineProcessor<
        import("../runtime/plugins/index.ts").ProcessorContext
      >({
        id: "cold-origin.invoke",
        on: [{ eventType: "test.request" }],
        async handle(_event, context) {
          const invoke = context.actions.protected as (
            input: { token: string },
            options: {
              operationKey: string;
              metadata: Record<string, unknown>;
            },
          ) => Promise<unknown>;
          await invoke({ token: "secret-origin-needle" }, {
            operationKey: "protected",
            metadata: { safe: "origin" },
          });
        },
      }),
    },
  });
  const options = {
    database: { query, transaction: db.transaction, close: db.close },
    namespace,
    databaseSchema: schema,
    plugins: [plugin],
    adapters: { secrets: { default: adapter } },
  };
  let application = await createCopilotzApplication(options);
  try {
    const sent = await application.send({ type: "test.request" });
    await sent.done;
    const invocation =
      (await application.events.list({ namespace, limit: 100 })).find((event) =>
        event.type === "test.cold-origin.invoked"
      )!;
    assert(invocation);
    // A fresh runtime has no recent-event or public-body cache.
    await application.shutdown();
    application = await createCopilotzApplication(options);
    executed.length = 0;
    decryptions = 0;
    let publicData: unknown;
    const resolve = createStreamOriginResolver(
      {
        operations: application.operations,
        events: {
          ...application.events,
          async resolve(tenant, eventId) {
            const event = await application.events.resolve(tenant, eventId);
            publicData = event?.data;
            return event;
          },
        },
      },
      namespace,
      new AbortController().signal,
    );
    const stream = {
      metadata: { sourceActionRunId: invocation.subject!.id },
    } as unknown as Parameters<typeof resolve>[1];
    const result = await resolve(sent.operationId, stream);
    assertEquals(result.metadata.sourceAction, {
      actionRunId: invocation.subject!.id,
      metadata: { safe: "origin" },
    });
    assertEquals(
      JSON.stringify(publicData).includes("secret-origin-needle"),
      false,
    );
    assertEquals(JSON.stringify(publicData).includes("$copilotz-secret"), true);
    assertEquals(decryptions, 0);
    assertEquals(executed.length, 3, executed.join("\n"));
    console.log(
      JSON.stringify({
        coldOriginStatements: executed.length,
        statements: executed.map((sql) => sql.trim().split("\n")[0]),
      }),
    );
    executed.length = 0;
    await resolve(sent.operationId, stream);
    assertEquals(executed.length, 0);
    const missing = {
      metadata: { sourceActionRunId: "missing" },
    } as unknown as Parameters<typeof resolve>[1];
    assertEquals(await resolve(sent.operationId, missing), missing);
    assertEquals(executed.length, 1);
  } finally {
    await application.shutdown();
    await db.close();
  }
});

Deno.test("stream origin ignores blank source run hints without catalog reads", async () => {
  const { createStreamOriginResolver } = await import("./stream-origin.ts");
  const resolve = createStreamOriginResolver(
    {
      operations: {
        findEventId() {
          throw new Error("Unexpected catalog read");
        },
      },
      events: {
        resolve() {
          throw new Error("Unexpected event read");
        },
      },
    } as unknown as Parameters<typeof createStreamOriginResolver>[0],
    "tenant",
    new AbortController().signal,
  );
  for (const sourceActionRunId of ["", "   ", undefined, 42]) {
    const output = { metadata: { sourceActionRunId } } as unknown as Parameters<
      typeof resolve
    >[1];
    assertEquals(await resolve("operation", output), output);
  }
});
