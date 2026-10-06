// deno-lint-ignore-file no-explicit-any
import {
  backendCpu,
  benchmarkRoot,
  benchmarkSchema,
  cpuDelta,
  nativeSession,
  pg,
  recordResult,
  url,
} from "./observation-native.ts";
const mode = Deno.args[0] ?? "current";
const viewers = Number(Deno.args[1] ?? 150);
const seconds = Number(Deno.args[2] ?? 10);
const renewalRate = Number(Deno.args[3] ?? 0);
const root = benchmarkRoot(mode);
const { createCopilotzApplication } = await import(
  root + "/runtime/application/application.ts"
);
const { defineCollection } = await import(
  root + "/runtime/collections/definition.ts"
);
const { createHttpReads } = await import(root + "/server/reads.ts");
const { createHttpOperations } = await import(root + "/server/operations.ts");
const { applicationOutputsMultipartResponse } = await import(
  root + "/server/multipart.ts"
);
const { decodeObservation } = await import(root + "/client/protocol.ts");
const { encodeOperationReplayCursor } = await import(
  root + "/runtime/streams/cursor.ts"
);
const schema = benchmarkSchema("idle", mode);
const native = nativeSession("observation_idle_" + mode, 4);
const { session, pids, pool } = native;
const monitor = new pg.Client({
  connectionString: url,
  application_name: "observation_idle_monitor",
});
await monitor.connect();
await monitor.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
const app = await createCopilotzApplication({
  database: session,
  namespace: "tenant",
  databaseSchema: schema,
  collections: {
    thread: defineCollection({
      name: "thread",
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    }),
  },
});
const historicalOperations = 3000,
  historicalEvents = 60000,
  conversations = 1500;
const exists = Number(
  (await monitor.query(
    `SELECT count(*) n FROM "${schema}".copilotz_operations`,
  )).rows[0].n,
);
if (!exists) {
  console.log(JSON.stringify({ stage: "seed", mode, schema }));
  await monitor.query(
    `INSERT INTO "${schema}".nodes(id, namespace, type, name, data) SELECT 'thread-'||i,'tenant','thread','Thread '||i,jsonb_build_object('id','thread-'||i) FROM generate_series(1,${conversations}) i`,
  );
  await monitor.query(
    `INSERT INTO "${schema}".events(id,schema_version,type,namespace,payload,metadata,correlation_id) SELECT 'historic-event-'||i,1,'test.history','tenant','{}',jsonb_build_object('core',jsonb_build_object('threadId','thread-'||((i-1)%${conversations}+1))),'history-correlation-'||((i-1)%${historicalOperations}+1) FROM generate_series(1,${historicalEvents}) i`,
  );
  await monitor.query(
    `INSERT INTO "${schema}".copilotz_operations(namespace,operation_id,root_event_id,correlation_id,metadata,state,accepted_at,updated_at,completed_at) SELECT 'tenant','historic-op-'||i,'historic-event-'||i,'history-correlation-'||i,jsonb_build_object('operationMetadata',jsonb_build_object('threadId','thread-'||((i-1)%${conversations}+1)),'observationKeys',jsonb_build_array('core.thread:thread-'||((i-1)%${conversations}+1))),'completed',now(),now(),now() FROM generate_series(1,${historicalOperations}) i`,
  );
  const columns = (await monitor.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='copilotz_operation_events'`,
    [schema],
  )).rows.map((r: any) => r.column_name);
  const local = columns.includes("event_ordinal");
  await monitor.query(
    `INSERT INTO "${schema}".copilotz_operation_events(namespace,operation_id,event_id,event_position,created_at${
      local ? ",event_ordinal" : ""
    }) SELECT namespace,'historic-op-'||((position-1)%${historicalOperations}+1),id,position,created_at${
      local ? ",((position-1)/" + historicalOperations + "+1)" : ""
    } FROM "${schema}".events`,
  );
  if (local) {
    await monitor.query(
      `UPDATE "${schema}".copilotz_operations SET next_event_ordinal=21`,
    );
    await monitor.query(
      `INSERT INTO "${schema}".copilotz_operation_selection_heads(namespace,selection_key,change_ordinal) SELECT 'tenant','core.thread:thread-'||i,40 FROM generate_series(1,${conversations}) i`,
    );
    await monitor.query(
      `INSERT INTO "${schema}".copilotz_operation_selections(namespace,selection_key,operation_id,change_ordinal) SELECT 'tenant','core.thread:thread-'||((i-1)%${conversations}+1),'historic-op-'||i,40 FROM generate_series(1,${historicalOperations}) i`,
    );
  }
  await monitor.query(`ANALYZE "${schema}".events`);
  await monitor.query(`ANALYZE "${schema}".copilotz_operations`);
  await monitor.query(`ANALYZE "${schema}".copilotz_operation_events`);
  await monitor.query(`ANALYZE "${schema}".nodes`);
}
if (mode !== "baseline") {
  await monitor.query(
    `INSERT INTO "${schema}".copilotz_operation_selections(namespace,selection_key,operation_id,change_ordinal) SELECT 'tenant','core.thread:thread-'||((i-1)%${conversations}+1),'historic-op-'||i,40 FROM generate_series(1,${historicalOperations}) i ON CONFLICT DO NOTHING`,
  );
}
const scope = { namespace: "tenant", databaseSchema: schema };
const read = await createHttpReads(app, scope, {});
const coordinator = await createHttpOperations(app, scope, {}, read);
const checkpoint = encodeOperationReplayCursor(
  mode === "baseline"
    ? { eventPosition: String(historicalEvents) }
    : { selectionPosition: "40" },
);
let observations = 0, active = 0;
const errors: string[] = [];
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  async (request) => {
    try {
      const threadId = new URL(request.url).searchParams.get("thread")!;
      const observation = await coordinator.observe({
        threadId,
        checkpoint,
        signal: request.signal,
      });
      observations++;
      active++;
      void observation.done.then(() => active--, (error: any) => {
        active--;
        errors.push(String(error));
      });
      return applicationOutputsMultipartResponse(observation, {
        signal: request.signal,
      });
    } catch (error) {
      errors.push(String(error));
      return new Response(String(error), { status: 500 });
    }
  },
);
const controllers = Array.from(
  { length: viewers },
  () => new AbortController(),
);
const loops: Promise<void>[] = [];
async function startClient(index: number) {
  const abort = controllers[index];
  const response = await fetch(
    `http://127.0.0.1:${server.addr.port}/?thread=thread-${index + 1}`,
    { signal: abort.signal },
  );
  if (!response.ok) throw new Error(await response.text());
  const loop = (async () => {
    try {
      for await (
        const _frame of decodeObservation(response)
      ) { /* Consume actual protocol frames. */ }
    } catch (error) {
      if (!abort.signal.aborted) errors.push(String(error));
    }
  })();
  loops[index] = loop;
}
for (let offset = 0; offset < viewers; offset += 50) {
  await Promise.all(
    Array.from(
      { length: Math.min(50, viewers - offset) },
      (_, i) => startClient(offset + i),
    ),
  );
}
await new Promise((resolve) => setTimeout(resolve, 1000));
const cpu = () => backendCpu(pids);
async function pgStats() {
  return (await monitor.query(
    "SELECT sum(calls)::float8 calls,sum(total_exec_time)::float8 exec_ms,sum(shared_blks_hit)::float8 hits FROM pg_stat_statements",
  )).rows[0];
}
const stat0 = await pgStats();
const cpu0 = await cpu();
native.reset();
const start = performance.now(), usage0 = Deno.memoryUsage();
console.log(
  JSON.stringify({
    stage: "measure",
    mode,
    viewers,
    observations,
    active,
    pids: [...pids],
  }),
);
let renewals = 0;
const renewalTask = (async () => {
  if (!(renewalRate > 0)) return;
  const interval = 1000 / renewalRate;
  for (let next = interval; next < seconds * 1000; next += interval) {
    const delay = start + next - performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const index = renewals % viewers;
    controllers[index].abort();
    await loops[index];
    controllers[index] = new AbortController();
    await startClient(index);
    renewals++;
  }
})();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
await renewalTask;
const wallMs = performance.now() - start,
  cpu1 = await cpu(),
  stat1 = await pgStats();
const result = {
  mode,
  viewers,
  distinctConversations: viewers,
  wallMs,
  calls: native.metrics().calls,
  renewalRate,
  renewals,
  queryElapsedMs: native.metrics().elapsedMs,
  backendCpu: cpuDelta(cpu0, cpu1),
  backendCpuMs: cpuDelta(cpu0, cpu1).milliseconds,
  backendCorePercent: cpuDelta(cpu0, cpu1).milliseconds / wallMs * 100,
  pgCalls: stat1.calls - stat0.calls,
  pgExecMs: stat1.exec_ms - stat0.exec_ms,
  pgSharedHits: stat1.hits - stat0.hits,
  rssBefore: usage0.rss,
  rssAfter: Deno.memoryUsage().rss,
  errors,
  topQueries: native.metrics().topQueries,
  note:
    "Real scoped application, collection reads, operation coordinator, native HTTP multipart response and canonical client decoder; combined server+client process memory; native local PostgreSQL; synthetic completed history.",
};
console.log(JSON.stringify(result));
await recordResult("observation-idle-results.jsonl", result);
for (const abort of controllers) abort.abort();
await Promise.allSettled(loops);
await server.shutdown();
const cleanupDeadline = performance.now() + 20_000;
while ((active || pool.waitingCount) && performance.now() < cleanupDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
console.log(
  JSON.stringify({
    stage: "cleanup",
    active,
    observations,
    poolWaiting: pool.waitingCount,
  }),
);
await app.shutdown();
await native.close();
await monitor.end();
