---
title: "Metrics"
description: "What the runtime and its plugins measure, the OpenTelemetry way: the meter, OTLP and Prometheus, and every metric recorded, copilotz.transaction.duration included."
section: Operations
order: 3
---

# Metrics

The runtime and its plugins measure what they do. There's no plugin to add: each plugin instruments
itself.

## The meter

Metrics follow OpenTelemetry's model: counters, histograms and gauges, aggregated in the process.
`createMetrics` makes the meter, with web standards only.

The host makes the meter and passes it to `createRuntime({ metrics })`, and to remote executors.
Plugin code records with `ctx.metrics`.

```ts
import { createRuntime } from "copilotz";
import { createMetrics, otlp } from "copilotz/exporters";

const meter = createMetrics({
  resource: { "service.name": "my-app" },
  exporters: [otlp({ url: "http://localhost:4318" })],
});
const runtime = await createRuntime({ store, plugins, metrics: meter });
```

## Where they go

Exporters come from `copilotz/exporters`:

- `otlp({ url })` sends OTLP/HTTP JSON to a collector.
- `exposition(meter)` answers Prometheus text. Serve it at `/metrics` as a plugin's route:
  `routes: { "/metrics": exposition(meter) }`.

The meter exports every 60 seconds unless told otherwise (`interval`). A host without timers, such as
Workers, calls `flush` instead.

A collector that's down is logged and never fails the runtime.

## What's recorded

The runtime:

| Metric                          | What it measures                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `copilotz.job.duration`         | jobs run on executors (Action calls, Processor deliveries, queries), by kind, name and outcome |
| `copilotz.op.duration`          | executors' requests, as the owner served them, by kind                                |
| `copilotz.op.roundtrip`         | the same requests, as executors waited for them                                       |
| `copilotz.commit.duration`      | commits to the store                                                                  |
| `copilotz.transaction.duration` | how long each transaction held open kept the store's writer, by outcome               |
| `copilotz.events`               | events committed                                                                      |
| `copilotz.processor.lag`        | events a Processor has yet to finish, by Processor                                    |
| `copilotz.executors`            | executors connected                                                                   |
| `copilotz.cache.reads`          | reads the owner's cache answered (hit) or passed to the store (miss)                  |
| `copilotz.timer.lateness`       | how long after its time a timer's occurrence was called                               |

`copilotz.transaction.duration` is new in 1.0.0-rc.31. A transaction's outcome is `commit`, `abort`,
`idle` or `error`. A transaction with no op for 5 seconds rolls back as `idle`.

Model calls, by OpenTelemetry's GenAI conventions:

| Metric                              | What it measures                                        |
| ----------------------------------- | ------------------------------------------------------- |
| `gen_ai.client.operation.duration`  | how long model calls took                               |
| `gen_ai.client.token.usage`         | tokens a model call used                                |
| `copilotz.llm.time_to_first_token`  | time to the first text or tool call of a streamed answer |

Plugins:

| Metric                             | What it measures                                                   |
| ---------------------------------- | ------------------------------------------------------------------ |
| `copilotz.usage.cost`              | the cost of uses, in USD, from the usage ledger                    |
| `copilotz.usage.price`             | the price of uses, in USD, from the usage ledger                   |
| `copilotz.memory.recall_failures`  | turns that went on without recalled memories because recall failed |

## Metrics and the ledger

Metrics are for dashboards and alerts. The usage ledger stays the record for billing.

## In Build Compass

[Chapter 37](../build-compass/part-12-shipping/37-watching-it-run.md) gives Compass a meter, reads
the numbers at `/metrics` and in the terminal, and sends them to an OpenTelemetry collector.
