import {
  type BodyStorageOptions,
  type BodyStore,
  createMemoryBodyStore,
} from "../content/body-store.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createEventStore, provisionCopilotzSchema } from "../events/index.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { openDatabaseOwner } from "../engine/commands.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { secret } from "../actions/secret.ts";
import { telegramSendTextAction } from "../../plugins/channel-telegram/actions/send-text/index.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createCopilotzWorker } from "../application/worker.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { listen } from "../adapters/deno/listen.ts";
import {
  createHypervisor,
  type WorkerCallContext,
  type WorkerCallOptions,
} from "../../dependencies/oxian-hypervisor.ts";
import {
  type CapabilityCall,
  encodeCapability,
  readCapability,
} from "./owner-capability-wire.ts";

const records = defineCollection({
  name: "connected_record",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      text: { type: "string" },
    },
    required: ["id", "namespace", "text"],
  } as const,
});
const namespace = "connected";
type FixtureOptions = {
  beforeCall?: (
    call: CapabilityCall,
    binding: WorkerCallContext,
  ) => void | Promise<void>;
  completed?: (operationId: string) => void;
  assets?: BodyStorageOptions;
  ownerAdapters?: Record<string, Record<string, unknown>>;
  actions: Record<string, ReturnType<typeof defineAction>>;
  fault?: (call: CapabilityCall) => boolean;
  transformCall?: (call: CapabilityCall) => CapabilityCall;
  resources?: Record<string, Record<string, unknown>>;
  adapters?: Record<string, Record<string, unknown>>;
  verifyEffectNotStarted?: import("../engine/types.ts").EffectNoStartVerifier;
};
async function fixture(
  kind: "in-process" | "websocket",
  options: FixtureOptions,
) {
  const database = await createOwnerTestDatabase();
  const topic = crypto.randomUUID();
  const workerId = "connected-worker";
  let dropped = 0;
  const admit: WorkerCallOptions["admit"] = (binding) => async (context) => {
    const original = await readCapability(context.input) as CapabilityCall;
    const call = options.transformCall?.(original) ?? original;
    await options.beforeCall?.(call, binding);
    const handler =
      await (binding.parent
        ? gateway.workerCalls.admit(binding)
        : gateway.workerCalls.admitUnassigned?.(binding));
    if (!handler) throw new Error("owner admission refused");
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encodeCapability(call));
        c.close();
      },
    });
    const result = await handler({ ...context, input });
    if (options.fault?.(call)) {
      dropped++;
      throw new Error("injected lost response after owner result");
    }
    return result;
  };
  const hostTransport = kind === "in-process"
    ? { type: "in-process", config: { topic } } as const
    : { type: "websocket", config: { path: "/worker" } } as const;
  const hypervisor = createHypervisor({
    transports: [hostTransport],
    workerCalls: {
      admit,
      admitUnassigned: admit,
      maxPerConnection: 128,
      maxConcurrent: 256,
    },
    ...(kind === "websocket"
      ? {
        admit(context) {
          return {
            definition: {
              workerId,
              providerId: "test",
              workloads: [...context.workloads],
              capacity: context.capacity,
              providerConfig: {},
              labels: {},
            },
            sessionGeneration: 1,
            authenticatedWith: context.credential.kind,
            resume: {
              credential: { kind: "resume", capability: "test-resume" },
              expiresAtMs: Date.now() + 60000,
            },
          };
        },
      }
      : {}),
  }, {
    onReady(context) {
      if (!context.workerCalls) throw new Error("missing reverse capability");
    },
    onDisconnect: (event) => gateway?.workerLifecycle?.onDisconnect?.(event),
    async onComplete(event) {
      await gateway?.workerLifecycle?.onComplete?.(event);
      options.completed?.(event.operationId);
    },
  });
  const gateway = await createCopilotzGateway({
    namespace,
    database,
    assets: options.assets,
    actions: options.actions,
    collections: { records },
    resources: options.resources,
    adapters: options.ownerAdapters ?? options.adapters,
    dispatcher: () => hypervisor,
    target: { workerId },
    engine: {
      retryBaseMs: 0,
      random: () => 0,
      verifyEffectNotStarted: options.verifyEffectNotStarted,
    },
  });
  const listener = kind === "websocket"
    ? listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 })
    : undefined;
  const url = listener ? new URL("/worker", listener.url) : undefined;
  if (url) url.protocol = "ws:";
  const worker = await createCopilotzWorker({
    namespace,
    actions: options.actions,
    collections: { records },
    resources: options.resources,
    adapters: options.adapters,
    id: workerId,
    transport: kind === "in-process"
      ? { type: "in-process", config: { topic } }
      : {
        type: "websocket",
        config: { url: url!, allowInsecureLoopback: true },
      },
    ...(kind === "websocket"
      ? {
        activate: () => ({ workerId, attemptId: "attempt", epoch: 1 }),
        register: () => ({
          credential: {
            kind: "registration" as const,
            capability: "test-registration",
          },
          expiresAtMs: Date.now() + 60000,
        }),
        reconnectDelay: false as const,
      }
      : {}),
  });
  await worker.ready;
  return {
    gateway,
    database,
    worker,
    get dropped() {
      return dropped;
    },
    async close() {
      await worker.stop();
      await gateway.shutdown();
      await hypervisor.shutdown();
      await listener?.shutdown();
      await database.close();
    },
  };
}
for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: one worker context preserves atomic plans, local returns, snapshots, lazy prepare and child calls`, async () => {
    let preparations = 0;
    const child = defineAction({
      id: "connected.child",
      execute: (input: { value: string }) => input.value,
    });
    const run = defineAction({
      id: "connected.run",
      async execute(_input: unknown, ctx: ActionContext) {
        const local = () => "local-only callback";
        const returned = await ctx.transaction(async (tx) => {
          void tx.collections.records.create({ id: "first", text: "one" });
          await tx.collections.records.create({ id: "second", text: "two" });
          return local;
        }, { operationKey: "atomic" });
        assertEquals(returned, local);
        let escaped: unknown;
        const texts = await ctx.readSnapshot(async (scope) => {
          escaped = scope.collections.records;
          return (await scope.collections.records.list({
            order: { field: "id", direction: "asc" },
          })).map((row) => row.text);
        });
        await assertRejects(() =>
          (escaped as ActionContext["collections"][string]).list({})
        );
        const prepared = await ctx.actions.child.prepare(() => {
          preparations++;
          return { input: { value: "prepared" } };
        }, { operationKey: "capture" });
        const ordinary = await ctx.actions.child({ value: "child" }, {
          operationKey: "child",
        });
        return { texts, prepared, ordinary };
      },
    });
    const f = await fixture(transport, { actions: { run, child } });
    try {
      const result = await f.gateway.actions.run({}, {
        idempotencyKey: "main",
      });
      assertEquals(result, {
        texts: ["one", "two"],
        prepared: "prepared",
        ordinary: "child",
      });
      assertEquals(preparations, 1);
      assertEquals(
        (await f.database.query(
          "SELECT count(*)::int AS n FROM public.owner_receipts WHERE kind='collections.commit'",
        )).rows[0].n,
        1,
      );
    } finally {
      await f.close();
    }
  });
  Deno.test(`${transport}: lost transaction response recovers authenticated receipt without repeating mutations`, async () => {
    let lost = false;
    let executions = 0;
    const run = defineAction({
      id: "connected.receipt",
      async execute(_input: unknown, ctx: ActionContext) {
        executions++;
        return await ctx.transaction(async (tx) => {
          await tx.collections.records.create({
            id: "committed",
            text: "once",
          });
          return "confirmed";
        }, { operationKey: "commit" });
      },
    });
    const f = await fixture(transport, {
      actions: { run },
      fault: (call) => call.kind === "transaction" && !lost && (lost = true),
    });
    try {
      assertEquals(
        await f.gateway.actions.run({}, { idempotencyKey: "receipt" }),
        "confirmed",
      );
      assertEquals(f.dropped, 1);
      assertEquals(executions, 1);
      assertEquals(
        (await f.database.query(
          "SELECT count(*)::int AS n FROM public.nodes WHERE type='connected_record'",
        )).rows[0].n,
        1,
      );
    } finally {
      await f.close();
    }
  });
}

for (const transport of ["in-process", "websocket"] as const) {
  for (const boundary of ["begin", "confirm"] as const) {
    Deno.test(`${transport}: lost Telegram effect ${boundary} response never dispatches twice`, async () => {
      let dispatches = 0;
      let lost = false;
      const f = await fixture(transport, {
        actions: { send: telegramSendTextAction },
        resources: { channels: { telegram: { egress: "external" } } },
        adapters: {
          channelProviders: {
            telegram: {
              config: { botToken: "local-test-only" },
              fetch: () => {
                dispatches++;
                return Promise.resolve(
                  Response.json({ ok: true, result: { message_id: 17 } }),
                );
              },
            },
          },
        },
        fault: (call) =>
          call.kind === "call" && call.path?.[0] === "effect" &&
          call.path[1] === boundary && !lost && (lost = true),
      });
      const input = {
        channelId: "telegram",
        chatId: "chat",
        deliveryKey: "one",
        text: "test",
      };
      try {
        await f.gateway.actions.send(input, { idempotencyKey: "telegram" })
          .catch(() => undefined);
        await f.gateway.actions.send(input, { idempotencyKey: "telegram" })
          .catch(() => undefined);
        assertEquals(f.dropped, 1);
        assertEquals(dispatches, boundary === "begin" ? 0 : 1);
        const rows = await f.database.query(
          "SELECT status FROM public.action_effects",
        );
        assert(rows.rows.length > 0);
        assertEquals(
          rows.rows[0].status,
          boundary === "begin" ? "begun" : "confirmed",
        );
      } finally {
        await f.close();
      }
    });
  }
}

Deno.test("WebSocket no-start evidence is verified only by the owner and authorizes only a new step", async () => {
  const seen: string[] = [];
  const actions = {
    forged: defineAction({
      id: "connected.forged",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.effect.begin("old");
        await ctx.effect.notStarted("old", {
          source: "provider",
          reference: "forged",
        });
        return "unsafe";
      },
    }),
    trusted: defineAction({
      id: "connected.trusted",
      async execute(_input: unknown, ctx: ActionContext) {
        assertEquals(await ctx.effect.begin("old"), { status: "proceed" });
        await ctx.effect.notStarted("old", {
          source: "provider",
          reference: "trusted-record",
        });
        assertEquals((await ctx.effect.begin("old")).status, "not_started");
        assertEquals(await ctx.effect.begin("new"), { status: "proceed" });
        await ctx.effect.confirm("new", { sent: true });
        return "safe";
      },
    }),
  };
  const f = await fixture("websocket", {
    actions,
    verifyEffectNotStarted(ref, evidence, { signal }) {
      signal.throwIfAborted();
      assertEquals(ref.databaseSchema, "public");
      assertEquals(ref.namespace, namespace);
      assertEquals(ref.step, "old");
      seen.push(evidence.reference);
      return evidence.reference === "trusted-record";
    },
  });
  try {
    await assertRejects(() =>
      f.gateway.actions.forged({}, { idempotencyKey: "forged" })
    );
    assertEquals(
      await f.gateway.actions.trusted({}, { idempotencyKey: "trusted" }),
      "safe",
    );
    assertEquals(seen, ["forged", "trusted-record"]);
  } finally {
    await f.close();
  }
});

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: awaitOperation and operations.start retain continuation identity`, async () => {
    const child = defineAction({
      id: "connected.continuation-child",
      execute: (input: { depth: number }) => input.depth,
    });
    const run = defineAction({
      id: "connected.continuation",
      async execute(_input: unknown, ctx: ActionContext) {
        const operation = await ctx.operations.start({
          action: "child",
          input: { depth: 7 },
          operationKey: "child",
        });
        return ctx.awaitOperation({
          operationId: operation,
          handoff: { value: 7 },
        });
      },
      resume(handoff, outcome) {
        assertEquals(outcome.status, "completed");
        return (handoff as { value: number }).value;
      },
    });
    const f = await fixture(transport, { actions: { run, child } });
    try {
      assertEquals(
        await f.gateway.actions.run({}, { idempotencyKey: "continuation" }),
        7,
      );
    } finally {
      await f.close();
    }
  });
}
Deno.test("WebSocket protected input is opened by owner and secrets remain encrypted at rest", async () => {
  let opened = 0;
  const adapter = await testSecretAdapter();
  const run = defineAction({
    id: "connected.protected",
    inputSchema: {
      type: "object",
      properties: { token: secret({ type: "string" }) },
      required: ["token"],
    } as const,
    execute(input: { token: string }) {
      opened++;
      assertEquals(input.token, "protected-wire-value");
      return "safe";
    },
  });
  const f = await fixture("websocket", {
    actions: { run },
    ownerAdapters: { secrets: { default: adapter } },
  });
  try {
    assertEquals(
      await f.gateway.actions.run({ token: "protected-wire-value" }, {
        idempotencyKey: "protected",
      }),
      "safe",
    );
    assertEquals(opened, 1);
    const rows = await f.database.query("SELECT body FROM public.event_bodies");
    assert(!JSON.stringify(rows.rows).includes("protected-wire-value"));
  } finally {
    await f.close();
  }
});

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: a swallowed indeterminate capability cannot publish successful Action output`, async () => {
    let lost = false;
    const run = defineAction({
      id: "connected.swallowed",
      async execute(_input: unknown, ctx: ActionContext) {
        try {
          await ctx.collections.records.create({
            id: "uncertain",
            text: "once",
          }, { operationKey: "write" });
        } catch { /* Plugin tries to swallow the uncertainty. */ }
        return "must not publish";
      },
    });
    const f = await fixture(transport, {
      actions: { run },
      fault: (call) =>
        call.kind === "call" &&
        call.path?.join(".") === "collections.records.create" && !lost &&
        (lost = true),
    });
    try {
      await assertRejects(() =>
        f.gateway.actions.run({}, { idempotencyKey: "swallowed" })
      );
      assertEquals(f.dropped, 1);
      assertEquals(
        (await f.database.query(
          "SELECT count(*)::int AS n FROM public.nodes WHERE type='connected_record'",
        )).rows[0].n,
        1,
      );
      const completed = await f.database.query(
        "SELECT count(*)::int AS n FROM public.events WHERE type='connected.swallowed.completed'",
      );
      assertEquals(completed.rows[0].n, 0);
    } finally {
      await f.close();
    }
  });
}
for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: lost owner Open acknowledgement requires a fresh acknowledged Open before execution`, async () => {
    let lost = false, executions = 0, acknowledged = 0;
    const run = defineAction({
      id: "connected.claim",
      execute() {
        assert(
          acknowledged > 0,
          "execution requires a fresh positive Open acknowledgement",
        );
        executions++;
        return "safe";
      },
    });
    const f = await fixture(transport, {
      actions: { run },
      fault: (call) => {
        if (call.kind !== "open") return false;
        if (!lost) {
          lost = true;
          return true;
        }
        acknowledged++;
        return false;
      },
    });
    try {
      await f.gateway.actions.run({}, { idempotencyKey: "claim" }).catch(() =>
        undefined
      );
      assertEquals(f.dropped, 1);
      assert(executions <= 1);
      if (executions) assert(acknowledged >= 1);
    } finally {
      await f.close();
    }
  });
}

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: observational context clock advances while a handler runs`, async () => {
    const run = defineAction({
      id: "connected.clock",
      async execute(_input: unknown, ctx: ActionContext) {
        const first = ctx.now().getTime();
        await new Promise((resolve) => setTimeout(resolve, 25));
        const second = ctx.now().getTime();
        assert(second > first);
        return { elapsed: second - first };
      },
    });
    const f = await fixture(transport, { actions: { run } });
    try {
      const result = await f.gateway.actions.run({}, {
        idempotencyKey: "clock",
      }) as { elapsed: number };
      assert(result.elapsed >= 15);
    } finally {
      await f.close();
    }
  });
}
Deno.test("already-connected worker cannot become routable before capability host and retained recovery", async () => {
  const db = await createOwnerTestDatabase();
  const schema = "startup_capability";
  const topic = crypto.randomUUID();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    handled = Promise.withResolvers<void>(),
    activationEntered = Promise.withResolvers<void>(),
    activationRelease = Promise.withResolvers<void>();
  let held = false, executions = 0, ready = false;
  const processor = defineProcessor({
    id: "connected.startup",
    on: [{ eventType: "retained.work" }],
    async handle(_event, ctx) {
      await ctx.collections.records.create({
        id: "recovered",
        text: "retained",
      });
      executions++;
      handled.resolve();
    },
  });
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const store = createEventStore({ session: db, schema });
  const pending = await store.append({
    type: "retained.work",
    namespace,
    payload: {},
  }, ["processor:connected.startup"]);
  (await openDatabaseOwner(db, schema)).stop();
  const database = {
    ...db,
    transaction<T>(
      run: (tx: import("../events/session.ts").SqlExecutor) => T | Promise<T>,
    ) {
      return db.transaction<T>(async (tx) =>
        await run({
          async query<R extends Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) {
            if (sql.includes("owner_epoch <>")) {
              activationEntered.resolve();
              await activationRelease.promise;
            }
            return await tx.query<R>(sql, params);
          },
        })
      );
    },
    async query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      if (!held && sql.includes("SELECT epoch,holder")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return await db.query<T>(sql, params);
    },
  };
  const opening = createCopilotzGateway({
    database,
    namespace,
    databaseSchema: schema,
    collections: { records },
    processors: { startup: processor },
    transports: [{ type: "in-process", config: { topic } }],
    target: { workerId: "startup-worker" },
  });
  let gateway: Awaited<typeof opening> | undefined,
    worker: Awaited<ReturnType<typeof createCopilotzWorker>> | undefined;
  try {
    await entered.promise;
    worker = await createCopilotzWorker({
      namespace,
      databaseSchema: schema,
      collections: { records },
      processors: { startup: processor },
      id: "startup-worker",
      transport: { type: "in-process", config: { topic } },
    });
    void worker.ready.then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(ready, false);
    assertEquals(executions, 0);
    release.resolve();
    await activationEntered.promise;
    // The host must be installed before first activation, not merely before
    // application.startRecovery: activation itself can publish recovered work.
    let readyDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        worker.ready,
        new Promise<never>((_resolve, reject) => {
          readyDeadline = setTimeout(
            () =>
              reject(new Error("capability admission waited for activation")),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(readyDeadline);
    }
    assertEquals(executions, 0);
    activationRelease.resolve();
    gateway = await opening;
    await worker.ready;
    await handled.promise;
    const deadline = Date.now() + 5000;
    while (
      (await store.getDelivery(pending.deliveries[0].id))?.status !==
        "succeeded"
    ) {
      assert(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assertEquals(executions, 1);
    assertEquals(
      (await db.query(
        `SELECT count(*)::int AS n FROM "${schema}".nodes WHERE id='recovered'`,
      )).rows[0].n,
      1,
    );
  } finally {
    release.resolve();
    activationRelease.resolve();
    await worker?.stop();
    await (gateway ?? await opening.catch(() => undefined))?.shutdown();
    await db.close();
  }
});

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: hostile receipt-bound plans cannot write another namespace or publish mutation receipts`, async () => {
    let attacks = 0;
    const run = defineAction({
      id: "connected.hostile-plan",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.transaction(async (tx) => {
          await tx.collections.records.create({
            id: "hostile",
            text: "forged",
          });
        }, { operationKey: "hostile" });
      },
    });
    const f = await fixture(transport, {
      actions: { run },
      transformCall(call) {
        if (call.kind !== "transaction") return call;
        attacks++;
        const plan = call.plan!.map((operation) => ({
          ...operation,
          args: [operation.args[0], {
            namespace: "foreign",
            identity: {
              settlementScopeId: "foreign-operation",
              actionScopeId: "foreign-action",
            },
          }],
        }));
        // The hostile caller can produce a matching receipt intent; identity
        // validation must reject before the owner planner/commit boundary.
        return {
          ...call,
          plan,
          receipt: {
            ...call.receipt!,
            intent: JSON.parse(
              new TextDecoder().decode(
                encodeCapability({ plan, options: call.options }),
              ),
            ),
          },
        };
      },
    });
    try {
      await assertRejects(() =>
        f.gateway.actions.run({}, { idempotencyKey: "attack" })
      );
      assert(attacks > 0);
      for (
        const query of [
          "SELECT count(*)::int AS n FROM public.nodes WHERE type='connected_record'",
          "SELECT count(*)::int AS n FROM public.owner_receipts WHERE kind='collections.commit'",
          "SELECT count(*)::int AS n FROM public.events WHERE namespace='foreign' OR type LIKE 'connected_record.%'",
        ]
      ) assertEquals((await f.database.query(query)).rows[0].n, 0);
    } finally {
      await f.close();
    }
  });
}

// Cross-lane C/W gate: execute this pack after the reviewed catalog conversion
// is composed. The worker only sees generated descriptors and opaque handles.
for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: multi-frame capture preserves prepared metadata and adopts through the owner catalog`, async () => {
    let executions = 0;
    const chunks: number[] = [], keys: string[] = [];
    const body = new Uint8Array(2 * 1024 * 1024 + 3).map((_, i) => i % 251);
    const digest = await crypto.subtle.digest("SHA-256", body);
    const expectedDigest = `sha256:${
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")).join("")
    }`;
    const run = defineAction({
      id: "connected.large-capture",
      async execute(_input: unknown, ctx: ActionContext) {
        executions++;
        // Structural C contract keeps this test typecheckable before composition;
        // the missing owner implementation must fail, never skip or fall back.
        const content = ctx.content as typeof ctx.content & {
          capture(
            input: unknown,
            options: {
              operationKey: string;
              origin?: { type: string; id: string };
            },
          ): Promise<readonly unknown[]>;
        };
        const existing = await content.publish({
          id: "capture-existing",
          mediaType: "text/plain",
          body: new TextEncoder().encode("existing"),
        }, { operationKey: "existing" });
        const reference = {
          assetId: existing.id,
          kind: "text" as const,
          role: "body",
          mediaType: "text/plain",
          name: "existing.txt",
        };
        const pending = await content.capture({
          content: [reference, {
            assetId: "large-candidate",
            kind: "file",
            role: "attachment",
            mediaType: "application/octet-stream",
            name: "large.bin",
            metadata: { reference: "kept" },
          }],
          assets: [{
            id: "large-candidate",
            namespace: ctx.namespace,
            mediaType: "application/octet-stream",
            body,
            byteLength: body.length,
            digest: expectedDigest,
            metadata: { asset: "kept" },
          }],
        }, {
          operationKey: "prepared-large",
          origin: { type: "message", id: "capture-owner" },
        });
        assertEquals(pending[0], reference);
        assertEquals(Object.keys(pending[1] as object).sort(), [
          "byteLength",
          "digest",
          "mediaType",
          "pendingRef",
          "type",
        ]);
        assertEquals(
          (pending[1] as { byteLength: number }).byteLength,
          body.length,
        );
        assertEquals((pending[1] as { digest: string }).digest, expectedDigest);
        const refs = await content.materialize(pending as never, {
          origin: { type: "message", id: "capture-owner" },
        });
        assertEquals(refs[1].metadata, { reference: "kept" });
        assertEquals(refs[1].name, "large.bin");
        assertEquals((await content.get(refs[1].assetId))?.metadata, {
          asset: "kept",
        });
        const reader = (await content.open(refs[1])).getReader();
        let offset = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            assert(next.value.length <= 64 * 1024);
            assertEquals(
              next.value,
              body.slice(offset, offset + next.value.length),
            );
            offset += next.value.length;
          }
        } finally {
          reader.releaseLock();
        }
        assertEquals(offset, body.length);
        const authored = await content.capture([{
          type: "file",
          bytes: new Uint8Array(130_000).fill(7),
          mediaType: "application/octet-stream",
          name: "authored.bin",
        }, "tail"], { operationKey: "authored-large" });
        assertEquals(
          authored.map((value) => (value as { type: string }).type),
          ["content.pending", "content.pending"],
        );
        return { pending, refs, authored };
      },
    });
    const f = await fixture(transport, {
      actions: { run },
      transformCall(call) {
        if (call.kind === "call" && call.path?.join(".") === "append") {
          const bytes = (call.args?.[0] as { bytes: Uint8Array }).bytes;
          chunks.push(bytes.length);
          assert(bytes.length <= 64 * 1024);
        }
        if (
          call.kind === "call" && call.path?.join(".") === "content.openCapture"
        ) {
          keys.push(
            String((call.args?.[0] as { operationKey: string }).operationKey),
          );
        }
        return call;
      },
    });
    try {
      const first = await f.gateway.actions.run({}, {
        idempotencyKey: "capture",
      });
      const count = chunks.length;
      assert(count >= 36);
      assertEquals(keys.length, 3);
      assertEquals(new Set(keys).size, 3);
      assertEquals(
        await f.gateway.actions.run({}, { idempotencyKey: "capture" }),
        first,
      );
      assertEquals(chunks.length, count);
      assertEquals(executions, 1);
    } finally {
      await f.close();
    }
  });

  Deno.test(`${transport}: a swallowed lost capture-close acknowledgement cannot publish success`, async () => {
    let lost = false;
    const run = defineAction({
      id: "connected.capture-uncertain",
      async execute(_input: unknown, ctx: ActionContext) {
        const content = ctx.content as typeof ctx.content & {
          capture(
            input: unknown,
            options: { operationKey: string },
          ): Promise<unknown>;
        };
        try {
          await content.capture({
            type: "file",
            bytes: new Uint8Array(150_000).fill(3),
            mediaType: "application/octet-stream",
          }, { operationKey: "uncertain" });
        } catch {
          /* Even a plugin that swallows upload uncertainty cannot succeed. */
        }
        return "must not publish";
      },
    });
    const f = await fixture(transport, {
      actions: { run },
      fault: (call) =>
        call.kind === "call" && call.path?.join(".") === "close" && !lost &&
        (lost = true),
    });
    try {
      await assertRejects(() =>
        f.gateway.actions.run({}, { idempotencyKey: "capture-uncertain" })
      );
      assertEquals(f.dropped, 1);
      const rows = await f.database.query(
        "SELECT count(*)::int AS n FROM public.events WHERE type='connected.capture-uncertain.completed'",
      );
      assertEquals(rows.rows[0].n, 0);
    } finally {
      await f.close();
    }
  });
}

Deno.test("WebSocket lost append revokes an open writer and drains an uncertain physical fence before settling", async () => {
  const physical = createMemoryBodyStore({ backendId: "lost-append-physical" });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let physicalBodyId = "",
    priorGeneration = 0,
    fences = 0,
    lost = false,
    caught = false;
  const store: BodyStore = {
    ...physical,
    async fence(input) {
      fences++;
      physicalBodyId = input.writer.bodyId;
      priorGeneration = input.writer.generation;
      const result = await physical.fence(input);
      entered.resolve();
      await release.promise;
      // The physical fence committed, but its acknowledgement was lost. Catalog
      // cleanup must remain unconfirmed; this is not a fabricated successful abort.
      throw Object.assign(new Error("physical fence result unknown"), {
        code: "storage_result_unknown",
        resultWasLost: !!result,
      });
    },
  };
  const run = defineAction({
    id: "connected.capture-append-uncertain",
    async execute(_input: unknown, ctx: ActionContext) {
      try {
        await ctx.content.capture({
          type: "file",
          bytes: new Uint8Array(150_000).fill(6),
          mediaType: "application/octet-stream",
        }, { operationKey: "open-writer" });
      } catch {
        caught = true;
        await assertRejects(() => ctx.content.get("revoked-context"));
      }
      return "must not publish";
    },
  });
  const f = await fixture("websocket", {
    actions: { run },
    assets: { storage: { type: "custom", config: { store } } },
    fault: (call) =>
      call.kind === "call" && call.path?.join(".") === "append" && !lost &&
      (lost = true),
  });
  const within = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Open-writer drain did not settle.")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let settled = false;
  const result = f.gateway.actions.run({}, {
    idempotencyKey: "capture-append-uncertain",
  });
  void result.then(() => settled = true, () => settled = true);
  try {
    await within(entered.promise);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      settled,
      false,
      "terminal publication must wait for actual owner cleanup",
    );
    const head = await physical.head({ bodyId: physicalBodyId });
    assert(
      head && "writerGeneration" in head &&
        Number(head.writerGeneration) > priorGeneration,
    );
    assertEquals(
      (await f.database.query(
        "SELECT count(*)::int AS n FROM public.events WHERE type='connected.capture-append-uncertain.completed'",
      )).rows[0].n,
      0,
    );
    release.resolve();
    await within(assertRejects(() => result));
    assertEquals(caught, true);
    assertEquals(f.dropped, 1);
    assert(fences >= 1);
    const rows = await f.database.query(
      "SELECT revocation,terminal FROM public.content_logical_bodies WHERE terminal IS NULL",
    );
    assert(rows.rows.some((row) => row.revocation === "revoking"));
    assertEquals(
      (await f.database.query(
        "SELECT count(*)::int AS n FROM public.events WHERE type='connected.capture-append-uncertain.completed'",
      )).rows[0].n,
      0,
    );
  } finally {
    release.resolve();
    await within(result.catch(() => undefined));
    await within(f.close());
  }
});

Deno.test("websocket: bound placement retired before Open leaves delivery unclaimed and preserves receipt recovery", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    retired = Promise.withResolvers<void>(),
    replacementRelease = Promise.withResolvers<void>();
  let hold = false, intercepted = false, executions = 0;
  const priorDeliveries = new Set<string>();
  let binding: WorkerCallContext | undefined;
  const run = defineAction({
    id: "connected.no-open",
    async execute(input: { seed?: boolean }, ctx: ActionContext) {
      executions++;
      if (input.seed) {
        await ctx.transaction(async (tx) => {
          await tx.collections.records.create({
            id: "retained-receipt",
            text: "once",
          });
        }, { operationKey: "retained" });
      }
      return input.seed ? "seeded" : "replacement";
    },
  });
  const f = await fixture("websocket", {
    actions: { run },
    async beforeCall(call, source) {
      if (
        hold &&
        !priorDeliveries.has(String(source.parent?.metadata.deliveryId)) &&
        !intercepted && call.kind === "open"
      ) {
        intercepted = true;
        binding = source;
        entered.resolve();
        await release.promise;
        throw new Error("transport placement retired before owner Open");
      } else if (
        hold &&
        !priorDeliveries.has(String(source.parent?.metadata.deliveryId)) &&
        call.kind === "open"
      ) {
        await replacementRelease.promise;
      }
    },
    completed(operationId) {
      if (operationId === binding?.parent?.operationId) retired.resolve();
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("pre-Open retirement did not settle")),
      15000,
    );
  });
  try {
    assertEquals(
      await f.gateway.actions.run({ seed: true }, { idempotencyKey: "seed" }),
      "seeded",
    );
    const receipts = (await f.database.query(
      "SELECT * FROM public.owner_receipts WHERE kind='collections.commit' ORDER BY key",
    )).rows;
    assertEquals(receipts.length, 1);
    for (
      const row
        of (await f.database.query("SELECT id FROM public.event_deliveries"))
          .rows
    ) priorDeliveries.add(String(row.id));
    hold = true;
    const result = f.gateway.actions.run({}, { idempotencyKey: "replacement" });
    void result.catch(() => undefined);
    await Promise.race([entered.promise, deadline]);
    const deliveryId = binding!.parent!.metadata.deliveryId;
    const state = async () =>
      (await f.database.query(
        "SELECT status,attempts,lease_owner FROM public.event_deliveries WHERE id=$1",
        [deliveryId],
      )).rows;
    assertEquals(await state(), [{
      status: "pending",
      attempts: 0,
      lease_owner: null,
    }]);
    assertEquals(executions, 1);
    release.resolve();
    await Promise.race([retired.promise, deadline]);
    assertEquals(await state(), [{
      status: "pending",
      attempts: 0,
      lease_owner: null,
    }]);
    assertEquals(
      (await f.database.query(
        "SELECT * FROM public.owner_receipts WHERE kind='collections.commit' ORDER BY key",
      )).rows,
      receipts,
    );
    replacementRelease.resolve();
    await f.gateway.application.recoverAll({ limit: 100 });
    assertEquals(await Promise.race([result, deadline]), "replacement");
    assertEquals(executions, 2);
    assertEquals(
      await f.gateway.actions.run({ seed: true }, { idempotencyKey: "seed" }),
      "seeded",
    );
    assertEquals(executions, 2);
  } finally {
    clearTimeout(timer);
    release.resolve();
    replacementRelease.resolve();
    await f.close();
  }
});

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: safe effect references preserve one dispatch and encrypted terminal replay`, async () => {
    let dispatches = 0;
    let seals = 0;
    const crypto = await testSecretAdapter();
    const output = { ok: true, token: "connected-output-secret-4567" };
    const run = defineAction({
      id: "connected.protected-effect",
      outputSchema: {
        type: "object",
        required: ["ok", "token"],
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          token: secret({ type: "string" }),
        },
      } as const,
      async execute(_input: unknown, ctx: ActionContext) {
        assertEquals(ctx.adapters.secrets, undefined);
        const begun = await ctx.effect.begin("exchange");
        if (begun.status === "replay") return output;
        assertEquals(begun.status, "proceed");
        dispatches++;
        await ctx.effect.confirm("exchange", { reference: "accepted" });
        assertEquals(await ctx.effect.inspect("exchange"), {
          status: "replay",
          outcome: { reference: "accepted" },
        });
        assertEquals(await ctx.effect.begin("exchange"), {
          status: "replay",
          outcome: { reference: "accepted" },
        });
        return output;
      },
    });
    const f = await fixture(transport, {
      actions: { run },
      ownerAdapters: {
        secrets: {
          default: {
            seal: (input: Parameters<typeof crypto.seal>[0]) => {
              seals++;
              return crypto.seal(input);
            },
            open: crypto.open,
          },
        },
      },
    });
    try {
      assertEquals(
        await f.gateway.actions.run({}, { idempotencyKey: "protected-effect" }),
        output,
      );
      assertEquals(
        await f.gateway.actions.run({}, { idempotencyKey: "protected-effect" }),
        output,
      );
      assertEquals(dispatches, 1);
      assertEquals(seals, 1);
      const captures = (await f.database.query<{ result: { ref: unknown } }>(
        "SELECT result FROM public.owner_receipts WHERE kind='action.output.capture'",
      )).rows;
      assertEquals(captures.length, 0);
      const bodies = (await f.database.query<
        {
          body: {
            protected?: { output?: unknown };
            data?: { status?: string };
          };
        }
      >("SELECT body FROM public.event_bodies")).rows;
      const terminal = bodies.find((row) =>
        row.body.data?.status === "completed"
      );
      assert(terminal?.body.protected?.output);
      for (
        const table of [
          "events",
          "event_bodies",
          "owner_receipts",
          "action_effects",
          "nodes",
        ]
      ) {
        assert(
          !JSON.stringify(
            (await f.database.query(`SELECT * FROM public.${table}`)).rows,
          ).includes(output.token),
        );
      }
    } finally {
      await f.close();
    }
  });
}
Deno.test("WebSocket lost safe effect confirmation response preserves one dispatch and encrypted terminal", async () => {
  let dispatches = 0;
  let seals = 0;
  let lost = false;
  const adapter = await testSecretAdapter();
  const output = { token: "lost-output-secret-9132" };
  const run = defineAction({
    id: "connected.lost-protected-output",
    outputSchema: {
      type: "object",
      required: ["token"],
      additionalProperties: false,
      properties: { token: secret({ type: "string" }) },
    } as const,
    async execute(_input: unknown, ctx: ActionContext) {
      const begun = await ctx.effect.begin("exchange");
      if (begun.status === "replay") return output;
      assertEquals(begun.status, "proceed");
      dispatches++;
      await ctx.effect.confirm("exchange", { reference: "accepted" });
      return output;
    },
  });
  const f = await fixture("websocket", {
    actions: { run },
    ownerAdapters: {
      secrets: {
        default: {
          seal: (input: Parameters<typeof adapter.seal>[0]) => {
            seals++;
            return adapter.seal(input);
          },
          open: adapter.open,
        },
      },
    },
    fault: (call) =>
      call.kind === "call" && call.path?.join(".") === "effect.confirm" &&
      !lost && (lost = true),
  });
  try {
    await f.gateway.actions.run({}, { idempotencyKey: "lost-protected-output" })
      .catch(() => undefined);
    await f.gateway.actions.run({}, { idempotencyKey: "lost-protected-output" })
      .catch(() => undefined);
    assertEquals(f.dropped, 1);
    assertEquals(dispatches, 1);
    assertEquals(seals, 0);
    assertEquals(
      (await f.database.query("SELECT status FROM public.action_effects")).rows,
      [{ status: "confirmed" }],
    );
    assertEquals(
      (await f.database.query(
        "SELECT count(*)::int AS n FROM public.owner_receipts WHERE kind='action.output.capture'",
      )).rows[0].n,
      0,
    );
    for (
      const table of [
        "events",
        "event_bodies",
        "owner_receipts",
        "action_effects",
        "nodes",
      ]
    ) {
      assert(
        !JSON.stringify(
          (await f.database.query(`SELECT * FROM public.${table}`)).rows,
        ).includes(output.token),
      );
    }
  } finally {
    await f.close();
  }
});
