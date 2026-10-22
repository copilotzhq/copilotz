/**
 * Full gateway / owner / in-process worker turn benchmark.
 * nice -n 10 deno run -A scripts/benchmark-turn.ts --backend=postgres --out=/tmp/turn.json
 * Use a fresh process for each backend. No production database is reused.
 */
import { createCopilotzGateway } from "../runtime/application/gateway.ts";
import { admitActionRequest } from "../runtime/application/ingress/admit.ts";
import { hostIngressProof } from "../runtime/application/ingress/authority.ts";
import { testAuthority } from "../runtime/testing/authority.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createHypervisor,
  type Hypervisor,
  type HypervisorOptions,
} from "../dependencies/oxian-hypervisor.ts";
import { createCopilotz } from "../create-copilotz.ts";
import { defineAction, definePlugin, defineProcessor } from "../index.ts";
import { corePlugin, defineAgent, defineTool } from "../plugins/core/index.ts";
import { coreHttpPlugin } from "../plugins/core-http/index.ts";
import { webChannelPlugin } from "../plugins/channels/index.ts";
import { memoryPlugin } from "../plugins/memory/plugin.ts";
import { usagePlugin } from "../plugins/usage/plugin.ts";
import type { LlmAdapter, LlmAdapterResult } from "../plugins/llm/index.ts";
import { openManagedOminipgDatabase } from "../runtime/persistence/index.ts";
import {
  bindSchemaOwner,
  currentOwnerCommand,
} from "../runtime/engine/commands.ts";
import { bindSqlDatabaseIdentity } from "../runtime/events/database-identity.ts";
import { retainReadSnapshotKind } from "../runtime/events/snapshot-kind.ts";
import type { SqlExecutor, SqlSession } from "../runtime/events/session.ts";
import type { DeliveryDiagnostic } from "../runtime/execution/types.ts";
import {
  SERVER_ACTION_REQUEST_EVENT_TYPE,
  SERVER_ACTION_REQUEST_SCHEMA,
} from "../runtime/application/ingress/contracts.ts";

const args = new Map(Deno.args.map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const backend = args.get("backend") ?? "postgres";
if (!["postgres", "pglite"].includes(backend)) {
  throw new Error("Invalid backend");
}
const samples = Number(args.get("n") ?? 5);
const latency = Number(args.get("model-ms") ?? 0);
const chunks = Number(args.get("chunks") ?? 0);
const idleMs = Number(args.get("idle-ms") ?? 30_000);
for (const value of [samples, latency, chunks, idleMs]) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid numeric option");
  }
}
const schema = `perf_turn_${crypto.randomUUID().replaceAll("-", "")}`;
const namespace = "turn";
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Turn benchmark timed out")),
          120_000 + latency * 3,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
await using cleanup = new AsyncDisposableStack();
const adminUrl = new URL(
  Deno.env.get("BENCH_DATABASE_URL") ??
    "postgres://postgres@localhost:55437/postgres",
);
if (backend === "postgres" && adminUrl.port !== "55437") {
  throw new Error("Benchmark PostgreSQL must use port 55437");
}
const admin = backend === "postgres"
  ? await openManagedOminipgDatabase({ url: adminUrl.href, pgPoolMax: 1 })
  : undefined;
if (admin) {
  cleanup.defer(() => admin.close());
  await admin.session.query(`CREATE DATABASE "${schema}"`);
  cleanup.defer(async () => {
    await admin.session.query(`DROP DATABASE "${schema}"`);
  });
}
adminUrl.pathname = `/${schema}`;
const managed = await openManagedOminipgDatabase({
  url: admin ? adminUrl.href : ":memory:",
  pgPoolMax: 1,
});
cleanup.defer(() => managed.close());
const sqlContext = new AsyncLocalStorage<string>();
let active = false;
let counters = {
  commands: 0,
  sql: 0,
  transactions: 0,
  deliveries: 0,
  hostCalls: 0,
};
let commandKinds: Record<string, number> = {};
let sqlKinds: Record<string, { count: number; ms: number }> = {};
let commandSql: Record<string, number> = {};
let diagnostics: DeliveryDiagnostic[] = [];
let commandDurations: Record<string, number[]> = {};
let hostCallDurations: number[] = [];
const query = (ex: SqlExecutor): SqlExecutor => ({
  async query(sql, params) {
    const measured = active;
    const key = sql.replaceAll(schema, "<schema>").replace(/\s+/g, " ").trim();
    const started = performance.now();
    if (measured) {
      counters.sql++;
      const kind = sqlContext.getStore() ?? "read/publication";
      commandSql[kind] = (commandSql[kind] ?? 0) + 1;
    }
    try {
      return await ex.query(sql, params);
    } finally {
      if (measured) {
        const entry = sqlKinds[key] ??= { count: 0, ms: 0 };
        entry.count++;
        entry.ms += performance.now() - started;
      }
    }
  },
});
const raw = managed.session;
const database: SqlSession = bindSqlDatabaseIdentity({
  ...query(raw),
  transaction(fn) {
    if (active) counters.transactions++;
    return raw.transaction((tx) => fn(query(tx)));
  },
  ...(raw.withReadSnapshot
    ? {
      withReadSnapshot: ((fn, options) => {
        if (active) counters.transactions++;
        return raw.withReadSnapshot!((scope) =>
          fn({
            ...scope,
            snapshot: query(scope.snapshot),
            ...(scope.kind === "pooled"
              ? {
                current: (op) => {
                  if (active) counters.transactions++;
                  return scope.current((tx) => op(query(tx)));
                },
              }
              : {}),
          }), options);
      }) as NonNullable<SqlSession["withReadSnapshot"]>,
    }
    : {}),
}, raw);
if (database.withReadSnapshot && raw.withReadSnapshot) {
  retainReadSnapshotKind(database.withReadSnapshot, raw.withReadSnapshot);
}
type Stage = ReturnType<typeof snapshot>;
let start = 0;
let stages: Record<string, Stage> = {};
function snapshot() {
  return {
    ms: performance.now() - start,
    ...counters,
    roundTrips: counters.sql + 2 * counters.transactions,
    commandKinds: { ...commandKinds },
    commandSql: { ...commandSql },
  };
}
function mark(name: string) {
  if (active && !stages[name]) stages[name] = snapshot();
}
let modelCalls = 0;
let toolCalls = 0;
let scenario = "plain";
const adapter: LlmAdapter = {
  call() {
    mark("modelStarted");
    modelCalls++;
    const tool = scenario === "tool" && modelCalls === 1;
    const replyText = chunks ? "x".repeat(chunks) : "Benchmark reply";
    const result = (async (): Promise<LlmAdapterResult> => {
      if (latency) await sleep(latency);
      return {
        content: tool ? [] : { type: "text", text: replyText, role: "body" },
        ...(tool
          ? {
            toolCalls: [{
              id: "bench-call",
              action: "echo",
              input: { value: "hello" },
            }],
            finishReason: "tool_calls",
          }
          : {}),
        attempts: [{
          status: "completed",
          usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        }],
      };
    })();
    return {
      result,
      frames: new ReadableStream({
        async start(controller) {
          await result;
          if (!tool) {
            for (let i = 0; i < chunks; i++) {
              controller.enqueue({
                lane: "content",
                mediaType: "text/plain",
                bytes: new TextEncoder().encode(
                  replyText[i],
                ),
              });
            }
          }
          controller.close();
        },
      }),
    };
  },
};
const echo = defineAction({
  id: "perf.echo",
  execute(input: { value: string }) {
    toolCalls++;
    return input;
  },
});
const product = definePlugin({
  id: "perf.turn",
  version: "1.0.0",
  actions: { echo },
  processors: {
    noop: defineProcessor({
      id: "perf.noop",
      on: [{ eventType: "message.created" }, { eventType: "perf.noop" }],
      handle() {},
    }),
  },
  resources: {
    agents: {
      north: defineAgent({
        id: "north",
        name: "North",
        role: "assistant",
        models: { generate: [{ connection: "fake", model: "fake" }] },
        capabilities: { tools: ["echo"] },
      }),
    },
    tools: {
      echo: defineTool("echo", echo, {
        name: "Echo",
        description: "Echo a value",
      }),
    },
    llmConnections: { fake: { adapter: "fake" } },
  },
  adapters: { llm: { fake: adapter } },
});
const plugins = [
  corePlugin,
  coreHttpPlugin,
  webChannelPlugin,
  memoryPlugin,
  usagePlugin,
  product,
] as const;
const transport = { type: "in-process", config: { topic: schema } } as const;
const onDiagnostic = (value: DeliveryDiagnostic) => {
  if (!active) return;
  diagnostics.push(value);
  if (value.phase === "placement_requested") counters.deliveries++;
};
let hypervisor: Hypervisor | undefined;
cleanup.defer(() => hypervisor?.shutdown());
type Admit = NonNullable<HypervisorOptions["workerCalls"]>["admit"];
const countedAdmit = (admit: Admit): Admit => async (binding) => {
  const handler = await admit(binding);
  if (!handler) return;
  return async (call) => {
    const measured = active,
      began = performance.now(),
      durations = hostCallDurations;
    if (measured) counters.hostCalls++;
    try {
      return await handler(call);
    } finally {
      if (measured) durations.push(performance.now() - began);
    }
  };
};
const gateway = await createCopilotzGateway({
  namespace,
  databaseSchema: schema,
  database: bindSqlDatabaseIdentity({
    ...database,
    transaction: <T>(fn: (tx: SqlExecutor) => T | Promise<T>) =>
      database.transaction(async (tx) => await fn(tx)),
    close: async () => {},
  }, database),
  authorization: {
    policies: {
      fixture: {
        revision: "1",
        sources: [],
        evaluate: () => ({ collections: { message: {} } }),
      },
    },
    collections: { message: { id: "fixture", revision: "1" } },
    actions: {},
  },
  plugins,
  dispatcher: ({ workerCalls, lifecycle }) =>
    hypervisor = createHypervisor({
      transports: [transport],
      workerCalls: {
        ...workerCalls,
        admit: countedAdmit(workerCalls.admit),
        ...(workerCalls.admitUnassigned
          ? { admitUnassigned: countedAdmit(workerCalls.admitUnassigned) }
          : {}),
      },
    }, lifecycle),
  target: { workerId: "perf-worker" },
  onDeliveryDiagnostic: onDiagnostic,
});
cleanup.defer(() => gateway.close());
const worker = await createCopilotz({
  role: "worker",
  namespace,
  plugins,
  transport,
  id: "perf-worker",
});
cleanup.defer(() => worker.close());
await worker.ready;
const owner = await bindSchemaOwner(database, schema)();
// Benchmark-only interception of local registrations. No production hot-path hook.
const register = owner.register.bind(owner);
Object.defineProperty(owner, "register", {
  value: ((kind, handler) => {
    const command = register(kind, {
      ...handler,
      execute: (input, context) =>
        sqlContext.run(kind, () => handler.execute(input, context)),
    });
    return (caller, request) => {
      const measured = active && !currentOwnerCommand();
      const began = performance.now();
      const durations = commandDurations;
      if (measured) {
        counters.commands++;
        commandKinds[kind] = (commandKinds[kind] ?? 0) + 1;
      }
      const result = command(caller, request);
      if (measured) {
        void result.finally(() =>
          (durations[kind] ??= []).push(performance.now() - began)
        ).catch(() => {});
      }
      return result;
    };
  }) as typeof owner.register,
});
const results: unknown[] = [];
function reset() {
  counters = {
    commands: 0,
    sql: 0,
    transactions: 0,
    deliveries: 0,
    hostCalls: 0,
  };
  commandKinds = {};
  sqlKinds = {};
  commandSql = {};
  diagnostics = [];
  stages = {};
  commandDurations = {};
  hostCallDurations = [];
  modelCalls = 0;
  toolCalls = 0;
  start = performance.now();
  active = true;
}
async function quiesce() {
  // Verification reads use the raw session and are excluded from measured SQL.
  const deadline = performance.now() + 120_000;
  while (true) {
    const rows = await raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${schema}".event_deliveries WHERE status NOT IN ('succeeded','dead_letter','cancelled')`,
    );
    if (!rows.rows[0].n) {
      await owner.drain();
      return;
    }
    if (performance.now() > deadline) throw new Error("Turn did not quiesce");
    await sleep(10);
  }
}
async function deliveries(correlationId: string) {
  const rows = (await raw.query(
    `SELECT d.consumer_id,d.status,d.attempts,
    EXTRACT(EPOCH FROM (d.settled_at-d.created_at))*1000 AS ms
    FROM "${schema}".event_deliveries d JOIN "${schema}".events e ON e.id=d.event_id
    WHERE e.correlation_id=$1 ORDER BY d.created_at,d.id`,
    [correlationId],
  )).rows;
  if (
    rows.some((row) => row.status !== "succeeded" || Number(row.attempts) !== 1)
  ) {
    throw new Error(
      "Benchmark delivery failed, retried, or remained unsettled",
    );
  }
  return rows;
}
const out = args.get("out") ?? `/tmp/turn-${backend}.json`;
const metadata = {
  backend,
  schema,
  samples,
  latency,
  chunks,
  date: new Date().toISOString(),
  deno: Deno.version,
};
async function save(extra: Record<string, unknown> = {}) {
  await Deno.writeTextFile(
    out,
    JSON.stringify({ ...metadata, results, ...extra }, null, 2) + "\n",
  );
}
try {
  for (const kind of ["plain", "tool"]) {
    for (let i = 0; i < samples; i++) {
      scenario = kind;
      const threadId = `${kind}-${i}`;
      await gateway.actions.createThread({
        id: threadId,
        participants: [
          { id: "user", externalId: "user", participantType: "human" },
          {
            id: "north",
            externalId: "north",
            participantType: "agent",
            agentId: "north",
          },
        ],
      });
      await quiesce();
      const subscription = await gateway.collections.message.observe({
        where: { threadId },
        limit: 100,
      }, { authority: testAuthority(schema, namespace) });
      const ready = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const reader = (async () => {
        for await (const frame of subscription.frames) {
          if (frame.t === "snapshot") ready.resolve();
          if (frame.t === "batch") {
            for (const delta of frame.changes) {
              if (delta.record?.senderId === "user") mark("messageVisible");
              if (
                delta.record?.senderId === "north" &&
                modelCalls === (kind === "tool" ? 2 : 1) &&
                Array.isArray(delta.record.content) &&
                delta.record.content.length > 0
              ) {
                mark("replyVisible");
                reply.resolve();
              }
            }
          }
        }
      })();
      await bounded(ready.promise);
      reset();
      const handle = await admitActionRequest(
        gateway.application,
        {
          namespace,
          databaseSchema: schema,
          deduplicationId: crypto.randomUUID(),
          type: SERVER_ACTION_REQUEST_EVENT_TYPE,
          payload: {
            schema: SERVER_ACTION_REQUEST_SCHEMA,
            requestId: crypto.randomUUID(),
            actionAlias: "sendConversation",
            actionMetadata: { httpActor: { id: "user" } },
            input: {
              threadId,
              recipientIds: ["north"],
              content: "Please reply",
            },
          },
        },
        gateway.application.plugins.actions.sendConversation.inputSchema,
        hostIngressProof(),
        true,
      );
      mark("sendAccepted");
      const outputs = (async () => {
        for await (const output of handle.outputs) {
          if ("payload" in output && output.payload instanceof ReadableStream) {
            await output.payload.cancel();
          }
        }
      })();
      await bounded(Promise.all([handle.done, outputs, reply.promise]));
      mark("turnSettled");
      await quiesce();
      mark("allDeliveriesSettled");
      active = false;
      if (
        modelCalls !== (kind === "tool" ? 2 : 1) ||
        toolCalls !== (kind === "tool" ? 1 : 0)
      ) throw new Error("Unexpected model/tool calls");
      results.push({
        scenario,
        stages,
        modelCalls,
        toolCalls,
        commandKinds,
        sqlKinds,
        commandSql,
        diagnostics,
        commandDurations,
        hostCallDurations,
        deliveries: await deliveries(handle.correlationId),
      });
      await save();
      console.log(JSON.stringify({ backend, scenario, sample: i, stages }));
      subscription.detach();
      await reader;
      await handle.detach();
      await owner.drain();
    }
  }
  for (let i = 0; i < samples; i++) {
    reset();
    const handle = await gateway.send({ type: "perf.noop", payload: {} });
    const drained = (async () => {
      for await (const _output of handle.outputs) { /* no streams */ }
    })();
    await bounded(Promise.all([handle.done, drained]));
    await quiesce();
    mark("turnSettled");
    active = false;
    results.push({
      scenario: "noop",
      stages,
      commandKinds,
      sqlKinds,
      commandSql,
      diagnostics,
      commandDurations,
      hostCallDurations,
      deliveries: await deliveries(handle.correlationId),
    });
    await save();
    await handle.detach();
    await owner.drain();
  }
  await quiesce();
  reset();
  await sleep(idleMs);
  const idle = {
    ...snapshot(),
    commandsPerSecond: idleMs ? counters.commands / (idleMs / 1000) : 0,
    commandKinds,
    sqlKinds,
  };
  active = false;
  await save({ idle });
  console.log(JSON.stringify({ backend, idle, out }));
} catch (error) {
  await save({
    failure: String(error),
    stages,
    commandKinds,
    sqlKinds,
    diagnostics,
  });
  throw error;
} finally {
  active = false;
}
