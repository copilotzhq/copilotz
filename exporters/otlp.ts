/**
 * OTLP/HTTP with JSON: sends snapshots to an OpenTelemetry collector (or any
 * backend that takes OTLP: Grafana, Honeycomb, Datadog…) with `fetch`, so it
 * works in every runtime. Sums and histograms are cumulative, as collected.
 */
import type { Attributes, Exporter, Snapshot } from "../runtime/metrics.ts";

const value = (v: string | number | boolean) =>
  typeof v === "string"
    ? { stringValue: v }
    : typeof v === "boolean"
    ? { boolValue: v }
    : Number.isInteger(v)
    ? { intValue: String(v) }
    : { doubleValue: v };

const attributes = (attrs: Attributes) =>
  Object.entries(attrs).map(([key, v]) => ({ key, value: value(v) }));

const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/** A snapshot as OTLP's JSON body (ExportMetricsServiceRequest). */
export function body(snapshot: Snapshot) {
  const CUMULATIVE = 2;
  return {
    resourceMetrics: [{
      resource: { attributes: attributes(snapshot.resource) },
      scopeMetrics: [{
        scope: { name: "copilotz" },
        metrics: snapshot.metrics.map((metric) => {
          const base = {
            name: metric.name,
            ...(metric.description ? { description: metric.description } : {}),
            ...(metric.unit ? { unit: metric.unit } : {}),
          };
          const points = metric.points.map((p) => ({
            attributes: attributes(p.attributes),
            startTimeUnixNano: nanos(p.start),
            timeUnixNano: nanos(p.time),
            ...("value" in p ? { asDouble: p.value } : {
              count: String(p.count),
              sum: p.sum,
              min: p.min,
              max: p.max,
              explicitBounds: p.bounds,
              bucketCounts: p.counts.map(String),
            }),
          }));
          return metric.kind === "sum"
            ? {
              ...base,
              sum: { dataPoints: points, aggregationTemporality: CUMULATIVE, isMonotonic: true },
            }
            : metric.kind === "histogram"
            ? { ...base, histogram: { dataPoints: points, aggregationTemporality: CUMULATIVE } }
            : { ...base, gauge: { dataPoints: points } };
        }),
      }],
    }],
  };
}

/** Posts every snapshot to `url` (`/v1/metrics` is added when missing). */
export function otlp(options: {
  url: string;
  headers?: Record<string, string>;
  /** Gives up on a request after this many ms (10 s). */
  timeout?: number;
}): Exporter {
  const url = options.url.endsWith("/v1/metrics")
    ? options.url
    : `${options.url.replace(/\/+$/, "")}/v1/metrics`;
  return {
    async export(snapshot) {
      if (!snapshot.metrics.length) return;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(body(snapshot)),
        signal: AbortSignal.timeout(options.timeout ?? 10_000),
      });
      if (!response.ok) {
        throw new Error(`OTLP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      await response.body?.cancel();
    },
  };
}
