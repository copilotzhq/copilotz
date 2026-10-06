// deno-lint-ignore-file no-explicit-any
import {
  backendCpu,
  benchmarkRoot,
  benchmarkSchema,
  cpuDelta,
  nativeSession,
  pause,
  pg,
  pgStats,
  recordResult,
  repositoryRoot,
  url,
} from "./observation-native.ts";
import process from "node:process";
import { fileURLToPath } from "node:url";
const viewers = Number(Deno.args[0] ?? 1000),
  active = Number(Deno.args[1] ?? 100),
  seconds = Number(Deno.args[2] ?? 10),
  recordBytes = Number(Deno.args[3] ?? 256),
  slow = Deno.args[4] === "slow";
const mode = Deno.args[5] ?? "current";
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
const { encodeOperationReplayCursor } = await import(
  root + "/runtime/streams/cursor.ts"
);
const { createOperationCatalog } = await import(
  root + "/runtime/streams/catalog.ts"
);
const { createDatabaseBodyStore } = await import(
  root + "/runtime/content/database-body-store.ts"
);
const schema = benchmarkSchema("stream", mode);
const observer = nativeSession("integration_stream_observer", 8),
  writer = nativeSession("integration_stream_writer", 8);
const monitor = new pg.Client({
  connectionString: url,
  application_name: "integration_stream_monitor",
});
await monitor.connect();
await monitor.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
// This schema is wholly owned by this synthetic harness. Clear it to prevent stale open lanes between trials.
await monitor.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
const app = await createCopilotzApplication({
  database: observer.session as any,
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
await monitor.query(
  `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) SELECT 'thread-'||i,'tenant','thread','Thread '||i,jsonb_build_object('id','thread-'||i) FROM generate_series(1,$1::int)i`,
  [Math.max(1000, viewers)],
);
const catalog = createOperationCatalog(writer.session as any, schema);
const store = createDatabaseBodyStore({
  session: writer.session as any,
  schema,
  protectionMs: 60000,
});
const lanes: any[] = [];
for (let start = 0; start < active; start += 20) {
  await Promise.all(
    Array.from({ length: Math.min(20, active - start) }, async (_, j) => {
      const index = start + j + 1,
        operationId = "operation-" + index,
        streamId = "stream-" + index,
        bodyId = "body-" + index;
      await writer.session.transaction(async (tx: any) => {
        const event = (await tx.query(
          `INSERT INTO "${schema}".events(id,schema_version,type,namespace,payload,metadata,correlation_id) VALUES($1,1,'bench.stream','tenant','{}',$2::jsonb,$1) RETURNING id,position,created_at`,
          [
            operationId,
            JSON.stringify({
              observationKeys: ["core.thread:thread-" + index],
              operationMetadata: { threadId: "thread-" + index },
            }),
          ],
        )).rows[0];
        await catalog.indexEvent(tx, {
          namespace: "tenant",
          operationId,
          eventId: operationId,
          position: String(event.position),
          correlationId: operationId,
          createdAt: event.created_at.toISOString(),
          metadata: {
            observationKeys: ["core.thread:thread-" + index],
            operationMetadata: { threadId: "thread-" + index },
          },
        });
      });
      const capability = await store.reserve({
        bodyId,
        mediaType: "application/octet-stream",
      });
      await catalog.openStream({
        namespace: "tenant",
        operationId,
        semanticStreamId: streamId,
        bodyId,
        descriptor: {
          type: "stream.output",
          namespace: "tenant",
          streamId,
          mediaType: "application/octet-stream",
          kind: "file",
          role: "assistant",
          metadata: {},
        } as any,
      });
      lanes.push({
        index,
        operationId,
        streamId,
        bodyId,
        capability,
        offset: 0,
      });
    }),
  );
}
lanes.sort((a, b) => a.index - b.index);
const scope = { namespace: "tenant", databaseSchema: schema },
  read = await createHttpReads(app as any, scope, {}),
  coordinator = await createHttpOperations(app as any, scope, {}, read);
let ready = false,
  stop = false,
  recovering = false,
  drained = viewers === 0,
  observations = 0,
  live = 0,
  expected = 0;
const errors: string[] = [];
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/ready") {
      ready = true;
      return new Response("ok");
    }
    if (requestUrl.pathname === "/drained") {
      drained = true;
      return new Response("ok");
    }
    if (requestUrl.pathname === "/status") {
      return Response.json({
        stop,
        recovering,
        expected,
      });
    }
    try {
      const observation = await coordinator.observe({
        threadId: requestUrl.searchParams.get("thread")!,
        checkpoint: requestUrl.searchParams.get("checkpoint") ??
          encodeOperationReplayCursor({ selectionPosition: "0" }),
        signal: request.signal,
      });
      observations++;
      live++;
      void observation.done.then(() => live--, (error: unknown) => {
        live--;
        if ((error as any)?.code !== "observation_renewal_required") {
          errors.push(String(error));
        }
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
const child = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "-A",
    "--config",
    repositoryRoot + "/deno.json",
    fileURLToPath(new URL("./observation-client.ts", import.meta.url)),
    String(viewers),
    String(active),
    String(recordBytes),
    slow ? "slow" : "normal",
    `http://127.0.0.1:${server.addr.port}`,
  ],
  stdout: "piped",
  stderr: "piped",
}).spawn();
const setupDeadline = performance.now() + 60000;
while (!ready) {
  if (performance.now() > setupDeadline) {
    throw new Error("Client setup timed out");
  }
  await pause(20);
}
await pause(1000);
const observer0 = await backendCpu(observer.pids),
  writer0 = await backendCpu(writer.pids),
  stats0 = await pgStats(monitor),
  serverCpu0 = process.cpuUsage();
observer.reset();
writer.reset();
const start = performance.now();
let peakServerRssBytes = Deno.memoryUsage().rss;
const memoryTimer = setInterval(() => {
  peakServerRssBytes = Math.max(peakServerRssBytes, Deno.memoryUsage().rss);
}, 100);
const commits = new Map<string, number>();
let writes = 0, maxTickLagMs = 0;
console.log(
  JSON.stringify({
    stage: "measure",
    viewers,
    active,
    seconds,
    recordBytes,
    slow,
    observations,
    observerPids: [...observer.pids],
    writerPids: [...writer.pids],
  }),
);
for (let tick = 0; tick < seconds * 10; tick++) {
  const deadline = start + (tick + 1) * 100;
  await pause(Math.max(0, deadline - performance.now()));
  maxTickLagMs = Math.max(maxTickLagMs, performance.now() - deadline);
  await Promise.all(lanes.map(async (lane) => {
    const bytes = new Uint8Array(recordBytes);
    new DataView(bytes.buffer).setUint32(0, tick + 1);
    const range = await store.append({
      writer: lane.capability,
      expectedOffset: lane.offset,
      appendId: "append-" + (tick + 1),
      bytes,
    });
    lane.offset = range.endOffset;
    await catalog.commitStreamOffset({
      namespace: "tenant",
      operationId: lane.operationId,
      streamId: lane.streamId,
      committedOffset: lane.offset,
    });
    commits.set(lane.streamId + "#" + (tick + 1), Date.now());
    writes++;
  }));
}
expected = viewers ? writes : 0;
const writeWallMs = performance.now() - start;
const observer1 = await backendCpu(observer.pids),
  writer1 = await backendCpu(writer.pids),
  stats1 = await pgStats(monitor),
  serverCpu = process.cpuUsage(serverCpu0);
clearInterval(memoryTimer);
const observerMeasured = observer.metrics(), writerMeasured = writer.metrics();
recovering = true;
for (const lane of lanes) {
  const head = await store.seal({
    writer: lane.capability,
    expectedByteLength: lane.offset,
  });
  await catalog.sealStream({
    namespace: "tenant",
    operationId: lane.operationId,
    streamId: lane.streamId,
    body: head,
  });
  await catalog.retainStream({
    namespace: "tenant",
    operationId: lane.operationId,
    streamId: lane.streamId,
    retention: "observation",
  });
}
const drainDeadline = performance.now() + 30000;
while (!drained && performance.now() < drainDeadline) await pause(20);
stop = true;
const out = await child.output();
const stderr = new TextDecoder().decode(out.stderr);
const client = JSON.parse(new TextDecoder().decode(out.stdout).trim());
const arrivals = client.arrivals;
delete client.arrivals;
const latencies = arrivals.map((arrival: any) =>
  arrival.at - commits.get(arrival.stream + "#" + arrival.sequence)!
).sort((a: number, b: number) => a - b);
const result = {
  mode,
  viewers,
  active,
  updatesPerActiveSecond: 10,
  seconds,
  recordBytes,
  slow,
  writeWallMs,
  achievedUpdatesPerSecond: writes / (writeWallMs / 1000),
  maxTickLagMs,
  writes,
  expectedDelivered: viewers ? writes : 0,
  observerBackendCpu: cpuDelta(observer0, observer1),
  writerBackendCpu: cpuDelta(writer0, writer1),
  observerBackendCorePercent: cpuDelta(observer0, observer1).milliseconds /
    writeWallMs * 100,
  writerBackendCorePercent: cpuDelta(writer0, writer1).milliseconds /
    writeWallMs * 100,
  observerQueries: observerMeasured,
  writerQueries: writerMeasured,
  pgCalls: stats1.calls - stats0.calls,
  pgExecMs: stats1.exec_ms - stats0.exec_ms,
  pgSharedHits: stats1.hits - stats0.hits,
  serverCpuMs: (serverCpu.user + serverCpu.system) / 1000,
  serverRssBytes: process.memoryUsage().rss,
  peakServerRssBytes,
  client,
  p50CommitAckToClientMs: latencies[Math.floor(latencies.length * .5)] ?? null,
  p99CommitAckToClientMs: latencies[Math.floor(latencies.length * .99)] ?? null,
  maxCommitAckToClientMs: latencies.at(-1) ?? null,
  missingCommitTimestamp:
    latencies.filter((n: number) => !Number.isFinite(n)).length,
  errors,
  clientStderr: stderr,
  note:
    "Real scoped application/read/operation coordinator, native HTTP multipart and separate canonical client process, existing database BodyStore and catalog; each Body append and catalog offset independently committed through existing APIs; native local PostgreSQL; synthetic fixture; no production traffic.",
};
console.log(JSON.stringify(result));
await recordResult("observation-stream-results.jsonl", result);
await pause(100);
console.log(
  JSON.stringify({
    stage: "cleanup",
    observations,
    live,
    observerPoolWaiting: observer.pool.waitingCount,
    writerPoolWaiting: writer.pool.waitingCount,
  }),
);
await server.shutdown();
await app.shutdown();
await observer.close();
await writer.close();
await monitor.end();
