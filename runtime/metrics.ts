/**
 * Metrics, in OpenTelemetry's model: counters (sums that only grow),
 * histograms (distributions, in buckets) and gauges (the last value), each
 * point keyed by its attributes. They aggregate here, in the process, and an
 * exporter sends what they hold every `interval` (OTLP, Prometheus: see
 * exporters/). Web standards only, so any runtime and host.
 *
 * The runtime records its own (jobs, commits, ops, cache, processor lag), and
 * plugins add theirs with `ctx.metrics`. Without metrics configured, every
 * instrument does nothing.
 */

export type Attributes = Record<string, string | number | boolean>;

export type InstrumentOptions = { description?: string; unit?: string };

export type Counter = { add(value: number, attributes?: Attributes): void };
export type Histogram = { record(value: number, attributes?: Attributes): void };
export type Gauge = { set(value: number, attributes?: Attributes): void };

/** What plugins and the runtime record with. */
export type Metrics = {
  counter(name: string, options?: InstrumentOptions): Counter;
  histogram(name: string, options?: InstrumentOptions & { buckets?: number[] }): Histogram;
  gauge(name: string, options?: InstrumentOptions): Gauge;
};

/** One point: a sum, a gauge's value, or a histogram's buckets. */
export type Point =
  & { attributes: Attributes; start: number; time: number }
  & (
    | { value: number }
    | {
      count: number;
      sum: number;
      min: number;
      max: number;
      /** Upper bounds; counts has one more, for what's above the last. */
      bounds: number[];
      counts: number[];
    }
  );

export type Metric = {
  name: string;
  description?: string;
  unit?: string;
  kind: "sum" | "histogram" | "gauge";
  points: Point[];
};

/** Everything held, as cumulative totals since the start. */
export type Snapshot = { resource: Attributes; metrics: Metric[] };

/** Sends snapshots somewhere: an OTLP collector, a log. */
export type Exporter = { export(snapshot: Snapshot): Promise<void> | void };

/** OpenTelemetry's default histogram buckets (for milliseconds). */
export const BUCKETS = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];

/** Past this many attribute sets, an instrument's new ones fold into one (OpenTelemetry's overflow). */
const LIMIT = 2_000;
const OVERFLOW = { "otel.metric.overflow": true };

const noop = { add() {}, record() {}, set() {} };

/** Records nothing. */
export const noMetrics: Metrics = {
  counter: () => noop,
  histogram: () => noop,
  gauge: () => noop,
};

type State = { attributes: Attributes; start: number; time: number } & Record<string, unknown>;

/** Attributes in a stable order, so equal sets are one key. */
const keyOf = (attributes: Attributes) =>
  JSON.stringify(Object.keys(attributes).sort().map((key) => [key, attributes[key]]));

export function createMetrics(options: {
  /** Who is measured: `service.name`, `service.instance.id`… */
  resource?: Attributes;
  exporters?: Exporter[];
  /** How often to export, in ms (60 s). Hosts without timers (Workers) call `flush` instead. */
  interval?: number;
} = {}): Metrics & {
  /** Everything held now. */
  collect(): Snapshot;
  /** Exports now. */
  flush(): Promise<void>;
  /** Exports one last time and stops. */
  close(): Promise<void>;
} {
  const instruments = new Map<
    string,
    { metric: Omit<Metric, "points">; points: Map<string, State>; buckets?: number[] }
  >();
  const exporters = options.exporters ?? [];

  const instrument = (
    name: string,
    kind: Metric["kind"],
    o: InstrumentOptions & { buckets?: number[] } = {},
  ) => {
    let found = instruments.get(name);
    if (!found) {
      found = {
        metric: {
          name,
          kind,
          ...(o.description ? { description: o.description } : {}),
          ...(o.unit ? { unit: o.unit } : {}),
        },
        points: new Map(),
        ...(kind === "histogram" ? { buckets: o.buckets ?? BUCKETS } : {}),
      };
      instruments.set(name, found);
    }
    const { points } = found;
    /** The point for these attributes, made on first use. */
    return (attributes: Attributes = {}, init: () => Record<string, unknown>) => {
      let key = keyOf(attributes);
      let point = points.get(key);
      if (!point) {
        if (points.size >= LIMIT) {
          key = keyOf(OVERFLOW);
          point = points.get(key);
          attributes = OVERFLOW;
        }
        if (!point) {
          const now = Date.now();
          point = { attributes: { ...attributes }, start: now, time: now, ...init() };
          points.set(key, point);
        }
      }
      point.time = Date.now();
      return point;
    };
  };

  const metrics: Metrics = {
    counter(name, o) {
      const point = instrument(name, "sum", o);
      return {
        add(value, attributes) {
          if (!(value >= 0)) return; // Sums only grow.
          const p = point(attributes, () => ({ value: 0 }));
          p.value = (p.value as number) + value;
        },
      };
    },
    histogram(name, o) {
      const point = instrument(name, "histogram", o);
      const bounds = instruments.get(name)!.buckets!;
      return {
        record(value, attributes) {
          if (!Number.isFinite(value)) return;
          const p = point(attributes, () => ({
            count: 0,
            sum: 0,
            min: Infinity,
            max: -Infinity,
            counts: new Array(bounds.length + 1).fill(0),
          }));
          p.count = (p.count as number) + 1;
          p.sum = (p.sum as number) + value;
          p.min = Math.min(p.min as number, value);
          p.max = Math.max(p.max as number, value);
          let i = bounds.findIndex((bound) => value <= bound);
          if (i < 0) i = bounds.length;
          (p.counts as number[])[i]++;
        },
      };
    },
    gauge(name, o) {
      const point = instrument(name, "gauge", o);
      return {
        set(value, attributes) {
          if (Number.isFinite(value)) point(attributes, () => ({ value: 0 })).value = value;
        },
      };
    },
  };

  const collect = (): Snapshot => ({
    resource: options.resource ?? {},
    metrics: [...instruments.values()].filter(({ points }) => points.size).map((
      { metric, points, buckets },
    ) => ({
      ...metric,
      points: [...points.values()].map(({ attributes, start, time, ...rest }): Point =>
        metric.kind === "histogram"
          ? {
            attributes,
            start,
            time,
            count: rest.count as number,
            sum: rest.sum as number,
            min: rest.min as number,
            max: rest.max as number,
            bounds: buckets!,
            counts: [...rest.counts as number[]],
          }
          : { attributes, start, time, value: rest.value as number }
      ),
    })),
  });

  const flush = async () => {
    if (!exporters.length) return;
    const snapshot = collect();
    await Promise.all(exporters.map(async (exporter) => {
      try {
        await exporter.export(snapshot);
      } catch (error) {
        // A collector that's down must never take the runtime with it.
        console.error(`metrics export failed: ${error instanceof Error ? error.message : error}`);
      }
    }));
  };

  // Export on a timer that never keeps the process alive.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (exporters.length && options.interval !== 0) {
    timer = setInterval(() => void flush(), options.interval ?? 60_000);
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    } else if (typeof timer === "number" && g.Deno?.unrefTimer) g.Deno.unrefTimer(timer);
  }

  return {
    ...metrics,
    collect,
    flush,
    async close() {
      if (timer !== undefined) clearInterval(timer);
      await flush();
    },
  };
}
