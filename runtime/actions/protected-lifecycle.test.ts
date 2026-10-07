import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createCoreTableNames } from "../events/index.ts";
import { createActionLifecycleLoader } from "./persistence.ts";
import { createEventStore } from "../events/store.ts";
import { protectedActionLifecycleBody } from "./protected-lifecycle.ts";
import { definePlugin, defineProcessor } from "../plugins/index.ts";
import type { ProcessorContext } from "../plugins/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "../application/application.ts";
import {
  createSecretAdapter,
  defineAction,
  type RuntimeActionCallers,
  secret,
  type SecretAdapter,
} from "./index.ts";
import { base64ToBytes, bytesToBase64 } from "../content/index.ts";

const SCHEMA = "protected_action_lifecycle";
const NAMESPACE = "protected-action-test";
const INPUT_SECRET = "input-secret-needle-7182";
const OUTPUT_SECRET = "output-secret-needle-9451";

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function testSecretAdapter(): Promise<SecretAdapter> {
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
            iv: buffer(iv),
            additionalData: buffer(additionalAuthenticatedData),
          },
          encryptionKey,
          buffer(plaintext),
        ),
      );
      const committed = new Uint8Array(
        additionalAuthenticatedData.byteLength + plaintext.byteLength,
      );
      committed.set(additionalAuthenticatedData);
      committed.set(plaintext, additionalAuthenticatedData.byteLength);
      const commitment = bytesToBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            commitmentKey,
            buffer(committed),
          ),
        ),
      );
      return Object.freeze({
        ciphertext,
        commitment,
        envelope: Object.freeze({ iv: bytesToBase64(iv), keyVersion: "test" }),
      });
    },
    async open({ ciphertext, additionalAuthenticatedData, envelope }) {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: buffer(base64ToBytes(String(envelope.iv))),
            additionalData: buffer(additionalAuthenticatedData),
          },
          encryptionKey,
          buffer(ciphertext),
        ),
      );
    },
  });
}

const protectedAction = defineAction({
  id: "test.protected-action",
  inputSchema: {
    type: "object",
    properties: {
      visible: { type: "string" },
      token: secret({ type: "string" }),
    },
    required: ["visible", "token"],
    additionalProperties: false,
  } as const,
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      sessionToken: { type: "string", "x-copilotz-secret": true },
    },
    required: ["ok", "sessionToken"],
    additionalProperties: false,
  } as const,
  execute(input: Readonly<{ visible: string; token: string }>) {
    assertEquals(input, { visible: "visible-input", token: INPUT_SECRET });
    return Object.freeze({ ok: true, sessionToken: OUTPUT_SECRET });
  },
});

Deno.test("protected Action lifecycle encrypts at rest and redacts ordinary observation", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const directOutputs: unknown[] = [];
  let executions = 0;
  const action = defineAction({
    ...protectedAction,
    execute(input: Readonly<{ visible: string; token: string }>) {
      executions++;
      return protectedAction.execute(input, undefined as never);
    },
  });
  const plugin = definePlugin({
    id: "test.protected-action-plugin",
    version: "1.0.0",
    actions: { protectedAction: action },
    processors: {
      invoke: defineProcessor<ProcessorContext>({
        id: "test.protected-action.invoke",
        on: [{ eventType: "test.protected-action.requested" }],
        async handle(_event, context) {
          const call = context.actions.protectedAction as unknown as (
            input: Readonly<{ visible: string; token: string }>,
            options: Readonly<{ operationKey: string }>,
          ) => Promise<unknown>;
          directOutputs.push(
            await call({
              visible: "visible-input",
              token: INPUT_SECRET,
            }, { operationKey: "protected" }),
          );
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    plugins: [plugin],
    adapters: { secrets: { default: await testSecretAdapter() } },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const run = await application.send({
      type: "test.protected-action.requested",
      deduplicationId: "protected-request",
    });
    const observed = [];
    for await (const output of run.outputs) observed.push(output);
    await run.done;

    assertEquals(executions, 1);
    assertEquals(directOutputs, [{ ok: true, sessionToken: OUTPUT_SECRET }]);
    const lifecycle = observed.filter((output) =>
      output.type === "test.protected-action.invoked" ||
      output.type === "test.protected-action.completed"
    );
    assertEquals(lifecycle.length, 2);
    const serializedObservation = JSON.stringify(lifecycle);
    assertEquals(serializedObservation.includes(INPUT_SECRET), false);
    assertEquals(serializedObservation.includes(OUTPUT_SECRET), false);
    assertEquals(serializedObservation.includes("$copilotz-secret"), true);

    const maintenance = await application.maintenance({
      namespace: NAMESPACE,
      assetOrphanAfterMs: 0,
      now: new Date("2100-01-01T00:00:00.000Z"),
    });
    assertEquals(maintenance.assets.orphanedBodiesDeleted, 0);
    await application.collections.rebuild(NAMESPACE);

    const tables = createCoreTableNames(SCHEMA);
    const eventBodies = await db.query<{ body: unknown }>(
      `SELECT body FROM ${tables.event_bodies}`,
    );
    const nodes = await db.query<{ type: string; data: unknown }>(
      `SELECT type, data FROM ${tables.nodes} ORDER BY type, id`,
    );
    const durableJson = JSON.stringify({ eventBodies, nodes });
    assertEquals(durableJson.includes(INPUT_SECRET), false);
    assertEquals(durableJson.includes(OUTPUT_SECRET), false);
    assertEquals(
      nodes.rows.filter((row) => row.type === "protected_value").length,
      2,
    );
    assertEquals(nodes.rows.some((row) => row.type === "asset"), false);
    const assetEvents = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${tables.events}
        WHERE type = 'asset.created'`,
    );
    assertEquals(Number(assetEvents.rows[0]?.n), 0);
  } finally {
    await application.shutdown();
    await db.close();
  }
});

Deno.test("secret schemas fail composition without a Secret Adapter", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await assertRejects(
      () =>
        createCopilotzApplication({
          database: db,
          namespace: NAMESPACE,
          databaseSchema: `${SCHEMA}_missing_adapter`,
          plugins: [definePlugin({
            id: "test.protected-action-missing-adapter",
            version: "1.0.0",
            actions: { protectedAction },
          })],
        }),
      TypeError,
      "adapters.secrets.default",
    );
  } finally {
    await db.close();
  }
});

Deno.test("delivery recovery reuses sealed Action input without opening or resealing it", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "protected_action_recovery";
  const tables = createCoreTableNames(schema);
  const adapter = await testSecretAdapter();
  let seals = 0;
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const action = defineAction({
    ...protectedAction,
    async execute(input: Readonly<{ visible: string; token: string }>) {
      assertEquals(input.token, INPUT_SECRET);
      started();
      await blocked;
      return { ok: true, sessionToken: OUTPUT_SECRET };
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: schema,
    engine: { maxAttempts: 1, execution: { heartbeatMs: 60_000 } },
    adapters: {
      secrets: {
        default: createSecretAdapter({
          seal(input) {
            seals++;
            return adapter.seal(input);
          },
          open() {
            throw new Error("Recovery must not decrypt input.");
          },
        }),
      },
    },
    plugins: [definePlugin({
      id: "test.protected-recovery",
      version: "1.0.0",
      actions: { action },
      processors: {
        start: defineProcessor<ProcessorContext>({
          id: "test.protected-recovery.start",
          on: [{ eventType: "test.start" }],
          async handle(_event, context) {
            await (context.actions as RuntimeActionCallers).action({
              visible: "visible-input",
              token: INPUT_SECRET,
            });
          },
        }),
      },
    })],
  });
  try {
    const sent = await app.send({ type: "test.start" });
    const done = sent.done.then(() => "completed", () => "failed");
    await sent.outputs.cancel();
    await entered;
    assertEquals(seals, 1);
    await db.query(
      `UPDATE ${tables.event_deliveries} SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE settlement_scope_id = $1 AND status = 'leased'`,
      [sent.eventId],
    );
    await app.maintenance();
    assertEquals(await done, "failed");
    assertEquals(seals, 1, "recovery did not reseal redacted input");
    const receipts = (await db.query<{ body: unknown }>(
      `SELECT body FROM ${tables.event_bodies} WHERE body ->> 'schema' = 'copilotz.action.lifecycle.protected.v1'`,
    )).rows.map((row) => protectedActionLifecycleBody(row.body)!);
    const invoked = receipts.find((body) => body.data.status === "invoked");
    const failed = receipts.find((body) => body.data.status === "failed");
    assertExists(invoked);
    assertExists(failed);
    assertEquals(failed.protected.input, invoked.protected.input);
    assertEquals(JSON.stringify(receipts).includes(INPUT_SECRET), false);
    const load = createActionLifecycleLoader({
      store: createEventStore({ session: db, schema }),
    });
    assertEquals(
      (await load(NAMESPACE, `${failed.data.actionRunId}:action:terminal`))
        ?.status,
      "failed",
    );
    release();
    await app.shutdown();
  } finally {
    release();
    await app.shutdown();
    await db.close();
  }
});

Deno.test("protected Actions reject secret metadata and progress with bounded durable errors", async () => {
  const schema = `${SCHEMA}_safety`;
  const namespace = `${NAMESPACE}-safety`;
  const db = await createTestDatabase({ url: ":memory:" });
  const caught: Error[] = [];
  const guarded = defineAction({
    id: "test.protected-action.safety",
    inputSchema: {
      type: "object",
      properties: { token: secret({ type: "string" }) },
      required: ["token"],
      additionalProperties: false,
    } as const,
    async execute(
      input: Readonly<{ token: string }>,
      context,
    ) {
      await context.progress({ token: input.token });
      return { ok: true };
    },
  });
  const plugin = definePlugin({
    id: "test.protected-action-safety-plugin",
    version: "1.0.0",
    actions: { guarded },
    processors: {
      invoke: defineProcessor<ProcessorContext>({
        id: "test.protected-action-safety.invoke",
        on: [{ eventType: "test.protected-action-safety.requested" }],
        async handle(_event, context) {
          const call = context.actions.guarded as unknown as (
            input: Readonly<{ token: string }>,
            options: Readonly<{
              operationKey: string;
              metadata?: Readonly<Record<string, unknown>>;
            }>,
          ) => Promise<unknown>;
          for (
            const options of [
              {
                operationKey: "metadata",
                metadata: { forbidden: INPUT_SECRET },
              },
              { operationKey: "progress" },
            ]
          ) {
            try {
              await call({ token: INPUT_SECRET }, options);
            } catch (error) {
              caught.push(error as Error);
            }
          }
        },
      }),
    },
  });
  const application = await createCopilotzApplication({
    database: db,
    namespace,
    databaseSchema: schema,
    plugins: [plugin],
    adapters: { secrets: { default: await testSecretAdapter() } },
  });
  try {
    const run = await application.send({
      type: "test.protected-action-safety.requested",
      deduplicationId: "safety-request",
    });
    const outputs = [];
    for await (const output of run.outputs) outputs.push(output);
    await run.done;

    assertEquals(caught.length, 2);
    assertEquals(
      caught[0]?.message.includes("metadata cannot contain"),
      true,
    );
    assertEquals(caught[1]?.message.includes("cannot persist progress"), true);
    const lifecycle = outputs.filter((output) =>
      output.type.startsWith("test.protected-action.safety.")
    );
    assertEquals(lifecycle.map((output) => output.type), [
      "test.protected-action.safety.invoked",
      "test.protected-action.safety.failed",
    ]);
    const failed = (lifecycle[1] as unknown as { data: unknown })
      .data as Record<
        string,
        unknown
      >;
    assertEquals(failed.error, {
      name: "Error",
      message: "Action execution failed.",
    });
    const tables = createCoreTableNames(schema);
    const bodies = await db.query<{ body: unknown }>(
      `SELECT body FROM ${tables.event_bodies}`,
    );
    assertEquals(
      JSON.stringify({ outputs, bodies }).includes(INPUT_SECRET),
      false,
    );
  } finally {
    await application.shutdown();
    await db.close();
  }
});
