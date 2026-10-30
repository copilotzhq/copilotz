/**
 * Prometheus's text exposition format, for a scraper to pull: the host serves
 * `exposition(metrics)` (a fetch handler) at `/metrics`, or calls `text`.
 * Names become Prometheus's: dots to underscores, counters end in `_total`.
 */
import type { Attributes, Snapshot } from "../runtime/metrics.ts";

const name = (metric: string) => metric.replace(/[^a-zA-Z0-9_:]/g, "_");
const escape = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
const labels = (attrs: Attributes, extra: Record<string, string> = {}) => {
  const all = [
    ...Object.entries(attrs).map(([k, v]) => [name(k), String(v)]),
    ...Object.entries(extra),
  ];
  return all.length ? `{${all.map(([k, v]) => `${k}="${escape(v)}"`).join(",")}}` : "";
};
const number = (n: number) => Number.isFinite(n) ? String(n) : n > 0 ? "+Inf" : "-Inf";

/** A snapshot as Prometheus text. */
export function text(snapshot: Snapshot): string {
  const lines: string[] = [];
  for (const metric of snapshot.metrics) {
    const base = name(metric.name);
    const id = metric.kind === "sum" ? `${base}_total` : base;
    if (metric.description) lines.push(`# HELP ${id} ${escape(metric.description)}`);
    lines.push(
      `# TYPE ${id} ${
        metric.kind === "sum" ? "counter" : metric.kind === "histogram" ? "histogram" : "gauge"
      }`,
    );
    for (const p of metric.points) {
      if ("value" in p) {
        lines.push(`${id}${labels(p.attributes)} ${number(p.value)}`);
        continue;
      }
      let cumulative = 0;
      p.bounds.forEach((bound, i) => {
        cumulative += p.counts[i];
        lines.push(`${id}_bucket${labels(p.attributes, { le: number(bound) })} ${cumulative}`);
      });
      lines.push(`${id}_bucket${labels(p.attributes, { le: "+Inf" })} ${p.count}`);
      lines.push(`${id}_sum${labels(p.attributes)} ${number(p.sum)}`);
      lines.push(`${id}_count${labels(p.attributes)} ${p.count}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** A fetch handler answering scrapes with what `metrics` holds now. */
export const exposition = (metrics: { collect(): Snapshot }) => (): Response =>
  new Response(text(metrics.collect()), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
