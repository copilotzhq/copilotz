/**
 * Metrics: instruments aggregate as OpenTelemetry's do, the runtime and the
 * plugins record what they do (jobs, commits, events, model calls by the
 * GenAI conventions, uses and their cost), and exporters send them
 * as OTLP/HTTP JSON or Prometheus text. A collector that's down never fails
 * the runtime.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMetrics, createRuntime, definePlugin, type Metric } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../plugins/models/mod.ts";
import { chat } from "../../plugins/agents/chat/mod.ts";
import usage from "../../plugins/billing/usage/mod.ts";
import { exposition, otlp, text } from "../mod.ts";
import { serve, test } from "../../testing/mod.ts";

const find = (metrics: Metric[], name: string) => metrics.find((m) => m.name === name);

test("instruments aggregate per attribute set, as OpenTelemetry's do", () => {
  const meter = createMetrics();
  const calls = meter.counter("calls");
  calls.add(2, { route: "a" });
  calls.add(3, { route: "a" });
  calls.add(1, { route: "b" });
  calls.add(-5, { route: "a" }); // Sums only grow.
  const latency = meter.histogram("latency", { unit: "ms", buckets: [10, 100] });
  for (const ms of [5, 50, 500, 7]) latency.record(ms);
  meter.gauge("queue").set(4);
  meter.gauge("queue").set(2);
  const { metrics } = meter.collect();
  assertEquals(
    find(metrics, "calls")!.points.map((p) => [p.attributes.route, "value" in p && p.value]),
    [["a", 5], ["b", 1]],
  );
  const [h] = find(metrics, "latency")!.points;
  assert(!("value" in h));
  assertEquals([h.count, h.sum, h.min, h.max, h.counts], [4, 562, 5, 500, [2, 1, 1]]);
  assertEquals(find(metrics, "queue")!.points.map((p) => "value" in p && p.value), [2]);
  // Past 2,000 attribute sets, new ones fold into one overflow point.
  const wide = meter.counter("wide");
  for (let i = 0; i < 2_100; i++) wide.add(1, { id: i });
  const points = find(meter.collect().metrics, "wide")!.points;
  assertEquals(points.length, 2_001);
  assertEquals(points.at(-1)!.attributes, { "otel.metric.overflow": true });
});

test("the runtime, the models and the ledger record what they do", async () => {
  const meter = createMetrics();
  const script: LlmAdapter = {
    async *generate() {
      yield { type: "text", text: "hi" };
      yield { type: "usage", input: 120, output: 8 };
    },
  };
  const runtime = await createRuntime({
    store: memoryStore(),
    metrics: meter,
    plugins: [
      models,
      chat,
      usage,
      definePlugin({
        name: "app",
        resources: {
          provider: { script: { adapter: "script" } },
          cost: { "script/*": { input: 1, output: 2 } },
          agents: { lead: { instructions: "Hi.", model: "script/lead" } },
        },
        adapters: { llm: { script } },
      }),
    ],
  });
  try {
    await runtime.call("chat.send", { text: "hello", from: "ana" });
    await runtime.idle();
  } finally {
    await runtime.close();
  }
  const { metrics } = meter.collect();
  const attrs = (name: string) => find(metrics, name)?.points.map((p) => p.attributes) ?? [];
  // Jobs on executors, by kind and name.
  assert(
    attrs("copilotz.job.duration").some((a) =>
      a.kind === "process" && a.name === "chat.turn" && a.outcome === "ok"
    ),
  );
  assert(attrs("copilotz.job.duration").some((a) => a.kind === "call" && a.name === "chat.send"));
  assert(attrs("copilotz.commit.duration").length);
  assert(attrs("copilotz.op.duration").some((a) => a.kind === "read"));
  assert(attrs("copilotz.op.roundtrip").length);
  assert(attrs("copilotz.events").some((a) => a.type === "message.created"));
  assert(attrs("copilotz.processor.lag").some((a) => a.processor === "chat.turn"));
  // Model calls, by OpenTelemetry's GenAI conventions.
  const genai = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": "script",
    "gen_ai.request.model": "lead",
  };
  assertEquals(attrs("gen_ai.client.operation.duration"), [genai]);
  assertEquals(attrs("copilotz.llm.time_to_first_token"), [genai]);
  const tokens = find(metrics, "gen_ai.client.token.usage")!.points;
  assertEquals(
    tokens.map((p) => [p.attributes["gen_ai.token.type"], "sum" in p && p.sum]),
    [["input", 120], ["output", 8]],
  );
  // What each use cost (the ledger's).
  const [cost] = find(metrics, "copilotz.usage.cost")!.points;
  assertEquals("value" in cost && cost.value, (120 * 1 + 8 * 2) / 1e6);
});

test("OTLP/HTTP JSON goes to the collector; one that's down fails nothing", async () => {
  const received: { path: string; type: string | null; body: Record<string, unknown> }[] = [];
  const collector = await serve(async (request) => {
    received.push({
      path: new URL(request.url).pathname,
      type: request.headers.get("content-type"),
      body: await request.json(),
    });
    return new Response("{}");
  });
  try {
    const meter = createMetrics({
      resource: { "service.name": "copilotz-test" },
      exporters: [otlp({ url: collector.url }), otlp({ url: "http://127.0.0.1:9" })],
      interval: 0,
    });
    meter.counter("calls", { unit: "{call}" }).add(2, { route: "a" });
    meter.histogram("latency", { unit: "ms", buckets: [10] }).record(5);
    meter.gauge("queue").set(3);
    await meter.flush(); // The second collector refuses: logged, not thrown.
    assertEquals(received.length, 1);
    assertEquals([received[0].path, received[0].type], ["/v1/metrics", "application/json"]);
    // deno-lint-ignore no-explicit-any
    const resource = (received[0].body as any).resourceMetrics[0];
    assertEquals(resource.resource.attributes, [
      { key: "service.name", value: { stringValue: "copilotz-test" } },
    ]);
    const [sum, histogram, gauge] = resource.scopeMetrics[0].metrics;
    assertEquals([sum.name, sum.unit, sum.sum.isMonotonic, sum.sum.aggregationTemporality], [
      "calls",
      "{call}",
      true,
      2,
    ]);
    assertEquals(sum.sum.dataPoints[0].asDouble, 2);
    assertEquals(sum.sum.dataPoints[0].attributes, [{ key: "route", value: { stringValue: "a" } }]);
    assertEquals(histogram.histogram.dataPoints[0].bucketCounts, ["1", "0"]);
    assertEquals(histogram.histogram.dataPoints[0].explicitBounds, [10]);
    assertEquals(gauge.gauge.dataPoints[0].asDouble, 3);
    await meter.close();
  } finally {
    await collector.close();
  }
});

test("Prometheus text: counters end in _total, histograms in cumulative buckets", async () => {
  const meter = createMetrics();
  meter.counter("copilotz.events", { description: "Events" }).add(3, { type: 'a"b' });
  meter.histogram("op.ms", { buckets: [10, 100] }).record(50);
  const out = text(meter.collect());
  assertStringIncludes(
    out,
    "# HELP copilotz_events_total Events\n# TYPE copilotz_events_total counter",
  );
  assertStringIncludes(out, 'copilotz_events_total{type="a\\"b"} 3');
  assertStringIncludes(
    out,
    'op_ms_bucket{le="10"} 0\nop_ms_bucket{le="100"} 1\nop_ms_bucket{le="+Inf"} 1',
  );
  assertStringIncludes(out, "op_ms_sum 50\nop_ms_count 1");
  const response = exposition(meter)();
  assertStringIncludes(response.headers.get("content-type")!, "text/plain; version=0.0.4");
  assertEquals(await response.text(), out);
});
