/** Source-only Action latency benchmark; use a fresh schema on local PostgreSQL. */
import {
  type ActionCallers,
  type ActionContext,
  createCopilotz,
  defineAction,
  defineCollection,
  definePlugin,
  defineProcessor,
  isStreamOutput,
  type ProcessorContext,
} from "../../index.ts";
import {
  type OminipgDatabaseLike,
  openManagedOminipgDatabase,
} from "../../runtime/persistence/index.ts";
import type { DeliveryDiagnostic } from "../../runtime/execution/types.ts";
import type { SqlExecutor } from "../../runtime/events/index.ts";

const samples = Number(Deno.env.get("BENCH_SAMPLES") ?? 30);
if (!Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("BENCH_SAMPLES must be a positive integer.");
}
const url = Deno.env.get("COPILOTZ_BENCH_POSTGRES_URL");
if (
  url && (!["postgres:", "postgresql:"].includes(new URL(url).protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname))
) {
  throw new Error("Benchmark requires local PostgreSQL.");
}
const schema = `bench_actions_${crypto.randomUUID().replaceAll("-", "")}`;
const managed = await openManagedOminipgDatabase(url ? { url } : {});
type Span = { name: string; start: number; ms: number };
let diagnostics: DeliveryDiagnostic[] = [];
let spans: Span[] = [];
let measuring = false;
const mark = (name: string, start: number) => {
  if (measuring) spans.push({ name, start, ms: performance.now() - start });
};
const timed = async <T>(name: string, fn: () => T | Promise<T>) => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    mark(name, start);
  }
};
const counted = (executor: SqlExecutor): SqlExecutor => ({
  query(sql, params) {
    return timed(
      `sql:${sql.replaceAll(/\s+/g, " ").trim()}`,
      () => executor.query(sql, params),
    );
  },
});
const database: OminipgDatabaseLike = {
  ...counted(managed.database),
  transaction: (fn) =>
    timed(
      "transaction",
      () => managed.database.transaction((tx) => fn(counted(tx))),
    ),
  ...(managed.database.listen
    ? { listen: managed.database.listen.bind(managed.database) }
    : {}),
  close: managed.close,
};
const row = defineCollection({
  name: "perf_row",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      invocation: { type: "string" },
      state: { type: "string" },
    },
    required: ["state"],
  } as const,
});
const noop = defineAction({
  id: "perf.noop",
  execute: () => timed("execute", () => ({ ok: true })),
});
const create = defineAction({
  id: "perf.create",
  execute: (_: unknown, ctx: ActionContext) =>
    timed(
      "execute",
      () =>
        ctx.collections.rows.create({ state: "accepted" }, {
          operationKey: `${ctx.operationKey}:create`,
        }),
    ),
});
const mix = defineAction({
  id: "perf.mix",
  execute: (_: unknown, ctx: ActionContext) =>
    timed("execute", async () => {
      const target = await timed("collection.get", () =>
        ctx.collections.targets.get({ id: "seed" }));
      if (!target) {
        throw new Error("Benchmark target is missing.");
      }
      const markers = await timed("collection.list", () =>
        ctx.collections.rows.list({
          where: { invocation: ctx.operationKey },
          limit: 1,
        }));
      if (markers.length) {
        throw new Error("Benchmark invocation repeated.");
      }
      const created = await timed("collection.create", () =>
        ctx.collections.rows.create({
          invocation: ctx.operationKey,
          state: "accepted",
        }, { operationKey: `${ctx.operationKey}:create` }));
      await timed("adapter", () =>
        (ctx.adapters.stub as { call(): Promise<void> }).call());
      return await timed("collection.update", () =>
        ctx.collections.rows.update({
          id: created.id,
          set: { state: "settled" },
        }, { operationKey: `${ctx.operationKey}:update` }));
    }),
});
const plugin = definePlugin({
  id: "perf",
  version: "1",
  collections: {
    rows: row,
    targets: defineCollection({ ...row, name: "perf_target" }),
  },
  actions: { noop, create, mix },
  processors: {
    invoke: defineProcessor<
      ProcessorContext<
        ProcessorContext["resources"],
        ProcessorContext["adapters"],
        ActionCallers<
          { noop: typeof noop; create: typeof create; mix: typeof mix }
        >
      >
    >({
      id: "perf.invoke",
      on: [{ eventType: "perf.request" }],
      async handle(event, ctx) {
        const variant =
          (event.data as { variant: "noop" | "create" | "mix" }).variant;
        await timed<unknown>("context.action", () => ctx.actions[variant]({}));
      },
    }),
  },
});
const app = await createCopilotz({
  namespace: "perf",
  databaseSchema: schema,
  database,
  plugins: [plugin],
  adapters: { stub: { call: () => Promise.resolve() } },
  onDeliveryDiagnostic(d: DeliveryDiagnostic) {
    mark(`diagnostic:${d.phase}`, performance.now());
    if (measuring) diagnostics.push(d);
  },
});
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const results: unknown[] = [];
try {
  await app.collections.targets.create({ id: "seed", state: "ready" });
  for (const path of ["host", "processor"]) {
    for (const variant of ["noop", "create", "mix"] as const) {
      const call = async () => {
        if (path === "host") return await app.actions[variant]({});
        const handle = await timed(
          "admission",
          () => app.send({ type: "perf.request", payload: { variant } }),
        );
        await Promise.all([
          handle.done,
          (async () => {
            for await (const out of handle.outputs) {
              if (isStreamOutput(out)) await out.payload.cancel();
            }
          })(),
        ]);
      };
      for (let i = 0; i < 3; i++) await call();
      const elapsed: number[] = [], inner: number[] = [];
      const totals = new Map<string, { calls: number; ms: number }>();
      let example: Span[] = [];
      const phases = new Map<string, number[]>();
      for (let i = 0; i < samples; i++) {
        spans = [];
        measuring = true;
        const start = performance.now();
        await call();
        const duration = performance.now() - start;
        elapsed.push(duration);
        measuring = false;
        const at = (phase: string) =>
          spans.find((s) => s.name === `diagnostic:${phase}`)!.start - start;
        const execution = spans.find((s) => s.name === "execute")!;
        let end = 0, idle = 0;
        for (
          const span of spans.filter((s) => s.name.startsWith("sql:")).sort((
            a,
            b,
          ) => a.start - b.start)
        ) {
          idle = Math.max(idle, span.start - start - end);
          end = Math.max(end, span.start - start + span.ms);
        }
        const breakdown = {
          admissionDelivery: at("placement_requested"),
          placement: at("placement_accepted") - at("placement_requested"),
          leaseAcquire: at("worker_claimed") - at("placement_accepted"),
          workerSetup: at("worker_handler_started") - at("worker_claimed"),
          beforeExecute: execution.start - start - at("worker_handler_started"),
          execute: execution.ms,
          afterExecute: at("worker_handler_settled") -
            (execution.start - start + execution.ms),
          afterHandler: duration - at("worker_handler_settled"),
          maxSqlIdle: Math.max(idle, duration - end),
        };
        for (const [name, ms] of Object.entries(breakdown)) {
          const values = phases.get(name) ?? [];
          values.push(ms);
          phases.set(name, values);
        }
        inner.push(spans.find((s) => s.name === "context.action")?.ms ?? 0);
        for (const s of spans) {
          const total = totals.get(s.name) ?? { calls: 0, ms: 0 };
          total.calls++;
          total.ms += s.ms;
          totals.set(s.name, total);
        }
        if (i === samples - 1) {
          example = spans.map((s) => ({ ...s, start: s.start - start }));
        }
      }
      const result = {
        backend: url ? "postgres" : "pglite",
        path,
        variant,
        samples,
        p50: percentile(elapsed, .5),
        p95: percentile(elapsed, .95),
        contextP50: percentile(inner, .5),
        contextP95: percentile(inner, .95),
        totals: [...totals].map(([name, t]) => ({
          name,
          calls: t.calls / samples,
          ms: t.ms / samples,
        })).sort((a, b) => b.ms - a.ms),
        example,
        exampleElapsedMs: elapsed.at(-1),
        phases: Object.fromEntries([...phases].map(([name, values]) => [name, {
          p50: percentile(values, .5),
          p95: percentile(values, .95),
        }])),
      };
      results.push(result);
      const output = Deno.env.get("BENCH_OUTPUT");
      if (output) {
        await Deno.writeTextFile(
          output,
          JSON.stringify(results, null, 2) + "\n",
        );
      }
      console.log(
        JSON.stringify({ ...result, totals: undefined, example: undefined }),
      );
      diagnostics = [];
      measuring = true;
      const startedAtMs = Date.now();
      const start = performance.now();
      const completions: number[] = [];
      const parallelLatencies: number[] = [];
      await Promise.all(Array.from({ length: 20 }, async () => {
        const callStart = performance.now();
        await call();
        parallelLatencies.push(performance.now() - callStart);
        completions.push(performance.now() - start);
      }));
      const parallelMs = performance.now() - start;
      measuring = false;
      results.push({
        backend: url ? "postgres" : "pglite",
        path,
        variant,
        parallel: 20,
        startedAtMs,
        parallelMs,
        parallelP50: percentile(parallelLatencies, .5),
        parallelP95: percentile(parallelLatencies, .95),
        completions,
        diagnostics: diagnostics.map((d) => ({
          phase: d.phase,
          status: d.status,
          timestampMs: d.timestampMs,
          deliveryId: d.deliveryId,
          dispatchAttemptId: d.dispatchAttemptId,
          consumerId: d.consumerId,
          origin: d.origin,
        })),
      });
      console.log(JSON.stringify({ path, variant, parallelMs }));
    }
  }
  const facts = await managed.database.query(
    `SELECT type, count(*)::int AS count FROM "${schema}".events GROUP BY type ORDER BY type`,
  );
  const deliveries = await managed.database.query(
    `SELECT status, attempts, count(*)::int AS count FROM "${schema}".event_deliveries GROUP BY status, attempts ORDER BY status, attempts`,
  );
  const calls = samples + 3 + 20;
  const eventCount = facts.rows.reduce(
    (count, row) => count + Number(row.count),
    0,
  );
  const deliveryCount = deliveries.rows.reduce(
    (count, row) => count + Number(row.count),
    0,
  );
  if (
    eventCount !== 30 * calls + 2 || deliveryCount !== 6 * calls + 1 ||
    deliveries.rows.some((row) =>
      row.status !== "succeeded" || row.attempts !== 1
    )
  ) {
    throw new Error(
      "Unexpected durable facts or delivery attempts in successful benchmark.",
    );
  }
  results.push({ facts: facts.rows, deliveries: deliveries.rows });
} finally {
  await app.close();
  await managed.database.query(`DROP SCHEMA "${schema}" CASCADE`);
  await managed.close();
}
const output = Deno.env.get("BENCH_OUTPUT");
if (output) {
  await Deno.writeTextFile(output, JSON.stringify(results, null, 2) + "\n");
}
