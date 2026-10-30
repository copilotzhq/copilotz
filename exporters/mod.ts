/**
 * Exporters: the runtime's `Exporter` port, implemented. They send what the
 * runtime and plugins measure (`ctx.metrics`) to systems outside it, the
 * OpenTelemetry way, and read nothing back: unlike stores, they're not where
 * the runtime keeps anything. The host picks them, as it picks the store;
 * plugins instrument themselves.
 *
 *   const meter = createMetrics({
 *     resource: { "service.name": "my-app" },
 *     exporters: [otlp({ url: "http://localhost:4318" })],
 *   });
 *   createRuntime({ store, plugins, metrics: meter });
 *   // and/or serve exposition(meter) at /metrics for Prometheus.
 *
 * What's recorded:
 * - the runtime: `copilotz.job.duration` (by kind, name, outcome),
 *   `copilotz.op.duration` and `copilotz.op.roundtrip`,
 *   `copilotz.commit.duration`, `copilotz.events`, `copilotz.processor.lag`,
 *   `copilotz.executors`, `copilotz.cache.reads`;
 * - model calls, by OpenTelemetry's GenAI conventions:
 *   `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, and
 *   `copilotz.llm.time_to_first_token`;
 * - the ledger: `copilotz.usage.cost` and `copilotz.usage.price` (USD).
 */
export { otlp } from "./otlp.ts";
export { exposition, text } from "./prometheus.ts";
export { createMetrics } from "../runtime/mod.ts";
