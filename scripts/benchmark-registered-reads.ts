/** Synthetic turn-setup selection on one owner, pool four. Run with deno run -A. */
import process from "node:process";
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";
import { createCollectionRuntime } from "../runtime/collections/kernel.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../runtime/events/index.ts";
import {
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../runtime/engine/commands.ts";
import { corePlugin } from "../plugins/core/plugin.ts";
import {
  type TurnContextArgs,
  turnContextRead,
} from "../plugins/core/shared/turn-context.ts";

const adminUrl = Deno.env.get("READS_BENCH_POSTGRES_URL") ??
  "postgres://postgres@localhost:55439/postgres";
const parsed = new URL(adminUrl);
if (
  !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
  parsed.port !== "55439"
) throw new Error("Use the local test server on port 55439.");
const admin = await openManagedOminipgDatabase({ url: adminUrl, pgPoolMax: 1 });
const databaseName = `reads_benchmark_${
  crypto.randomUUID().replaceAll("-", "")
}`;
await admin.session.query(`CREATE DATABASE "${databaseName}"`);
parsed.pathname = `/${databaseName}`;
const managed = await openManagedOminipgDatabase({
  url: parsed.href,
  pgPoolMax: 4,
});
const db = managed.session;
const schema = "read_benchmark";
await provisionCopilotzSchema(db, schema);
const owner = await openDatabaseOwner(db, schema);
owner.activate();
const store = createEventStore({ session: db, schema });
const coordinator: EventCoordinator = {
  async commitMutation(input) {
    return {
      ...await store.commitMutation({ ...input, consumers: [] }),
      dispatch: { handles: [], failures: [] },
    };
  },
  append() {
    throw new Error("unused");
  },
  recover() {
    throw new Error("unused");
  },
};
const runtime = createCollectionRuntime({
  session: db,
  eventStore: store,
  coordinator,
});
for (const definition of Object.values(corePlugin.collections)) {
  runtime.bind(definition);
}
const namespace = "synthetic";
const records: Array<{ type: string; data: Record<string, unknown> }> = [
  {
    type: "participant",
    data: {
      id: "user",
      externalId: "user",
      participantType: "human",
      metadata: {},
    },
  },
  {
    type: "participant",
    data: {
      id: "agent",
      externalId: "agent",
      participantType: "agent",
      agentId: "agent",
      metadata: {},
    },
  },
  {
    type: "thread",
    data: { id: "thread", participantIds: ["user", "agent"], metadata: {} },
  },
  ...Array.from({ length: 100 }, (_, index) => ({
    type: "message",
    data: {
      id: `message-${String(index).padStart(3, "0")}`,
      threadId: "thread",
      senderId: "user",
      recipientIds: ["agent"],
      content: [],
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    },
  })),
];
let trigger: TurnContextArgs["record"];
let closeWorker = () => {};
try {
  await db.transaction(async (tx) => {
    for (const item of records) {
      const data = {
        namespace,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...item.data,
        id: String(item.data.id),
      };
      await tx.query(
        `INSERT INTO "${schema}".nodes(namespace,id,type,name,data,created_at,updated_at) VALUES($1,$2,$3,$2,$4::jsonb,$5::timestamptz,$5::timestamptz)`,
        [namespace, data.id, item.type, JSON.stringify(data), data.createdAt],
      );
      if (item.type === "message") trigger = data as TurnContextArgs["record"];
    }
  });
  const context = {
    namespace,
    databaseSchema: schema,
    operationKey: "benchmark",
    identity: {},
    signal: new AbortController().signal,
    now: () => new Date(),
    resources: {
      agents: {
        agent: {
          id: "agent",
          name: "Synthetic",
          role: "assistant",
          instructions: "Return synthetic text.",
          models: { generate: [{ connection: "fixture", model: "fixture" }] },
        },
      },
    },
  };
  const input: TurnContextArgs = {
    record: trigger!,
    recipientId: "agent",
    agentTurn: null,
    initialAsk: null,
    initiatorParticipantId: "user",
    eventThreadId: "thread",
  };
  const scope = {
    namespace,
    reads: { turnContext: turnContextRead },
    aliases: corePlugin.collections,
    context,
  };
  const worker = new Worker(
    new URL("./registered-read-benchmark-worker.ts", import.meta.url),
    { type: "module" },
  );
  closeWorker = () => worker.terminate();
  const tasks = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(reason: unknown): void;
      collections?: Record<string, unknown>;
    }
  >();
  let taskId = 0;
  worker.onmessage = async ({ data }) => {
    const task = tasks.get(data.task ?? data.id)!;
    if (data.kind === "done") {
      tasks.delete(data.id);
      if (data.error) task.reject(new Error(data.error));
      else task.resolve(data.value);
      return;
    }
    try {
      const [name, method] = data.path;
      const value = name
        ? await (task.collections![name] as Record<
          string,
          (...args: unknown[]) => unknown
        >)[method](...data.args)
        : await runtime.read(scope, "turnContext", input);
      worker.postMessage({ kind: "result", id: data.id, value });
    } catch (error) {
      worker.postMessage({ kind: "result", id: data.id, error: String(error) });
    }
  };
  const select = (
    mode: "owner" | "worker",
    collections?: Record<string, unknown>,
  ) =>
    new Promise((resolve, reject) => {
      const id = ++taskId;
      tasks.set(id, { resolve, reject, collections });
      worker.postMessage({
        kind: "start",
        id,
        mode,
        input,
        names: Object.keys(corePlugin.collections),
        context: {
          namespace,
          databaseSchema: schema,
          operationKey: "benchmark",
          identity: {},
          resources: context.resources,
        },
      });
    });
  const read = () => select("owner");
  for (let i = 0; i < 10; i++) {
    const result = await read() as {
      value?: { snapshot: { active: boolean; records: unknown[] } };
      snapshot?: { active: boolean; records: unknown[] };
    };
    const selected = result.value?.snapshot ?? result.snapshot;
    if (!selected?.active || selected.records.length !== 100) {
      throw new Error("Benchmark must select all 100 synthetic messages.");
    }
  }
  const quantile = (values: number[], p: number) =>
    values.sort((a, b) =>
      a - b
    )[Math.min(values.length - 1, Math.floor(values.length * p))];
  const report = [];
  for (const concurrency of [1, 3, 50]) {
    const ms: number[] = [];
    const failures: Record<string, number> = {};
    const cpu = process.threadCpuUsage();
    for (let sample = 0; sample < 20; sample++) {
      await Promise.all(Array.from({ length: concurrency }, async () => {
        const start = performance.now();
        try {
          await read();
          ms.push(performance.now() - start);
        } catch (error) {
          const code = String((error as { code?: string }).code ?? error);
          failures[code] = (failures[code] ?? 0) + 1;
        }
      }));
    }
    const used = process.threadCpuUsage(cpu);
    report.push({
      concurrency,
      completed: ms.length,
      failures,
      p50Ms: quantile(ms, 0.5),
      p95Ms: quantile(ms, 0.95),
      ownerThreadCpuMsPerAttempt: (used.user + used.system) / 1000 /
        (20 * concurrency),
      ownerThreadCpuMsPerCompletedRead: (used.user + used.system) / 1000 /
        ms.length,
    });
  }
  worker.terminate();
  console.log(
    JSON.stringify({ pool: 4, messages: 100, samples: 20, report }, null, 2),
  );
} finally {
  closeWorker();
  await releaseDatabaseOwner(owner);
  await managed.close();
  await admin.session.query(`DROP DATABASE "${databaseName}"`);
  await admin.close();
}
