---
title: "Chapter 37: Watching it run"
description: "Copilotz measures itself: the runtime's jobs and commits, and every model call by OpenTelemetry's GenAI conventions. Give it a meter, read the numbers at /metrics as Prometheus text or in the terminal, and send them to an OpenTelemetry collector."
section: Build Compass
order: 370
status: stable
---

# Chapter 37: Watching it run

> Part 12, shipping · Requires: Chapter 36 · Code: `lesson-12.2`

## The pain

Compass runs all day now, on a database, with North answering. Then a turn feels slow. Is it the
model? The store? Something waiting in line? You have the record of what happened (every event), but
not how long anything took, or how often. You find out by guessing.

## The problem

Measuring belongs where the work is done, not sprinkled through the app by hand: the runtime knows
how long a job took and a commit, the models plugin how long a model call took. What the app decides
is where the numbers go: held in the process, read by a scraper, or sent to a collector. And like
everything here, they're yours: nobody else should read them.

## The solution

Copilotz already measures itself, in OpenTelemetry's model: counters, histograms and gauges. There's
no plugin to add: each plugin instruments itself through `ctx.metrics`. What it records:

- the runtime: `copilotz.job.duration` (jobs run on executors, by kind, name and outcome, in ms),
  `copilotz.op.duration`, `copilotz.op.roundtrip`, `copilotz.commit.duration`, `copilotz.events`,
  `copilotz.processor.lag`, `copilotz.executors`, `copilotz.cache.reads`;
- model calls, by OpenTelemetry's GenAI conventions: `gen_ai.client.operation.duration` (in
  seconds), `gen_ai.client.token.usage`, and `copilotz.llm.time_to_first_token`;
- the ledger, where there's one: `copilotz.usage.cost` and `copilotz.usage.price`.

Until the host gives it a meter, all of that goes nowhere. Three pieces: a meter, a route to read
it, and a command in the terminal.

### A meter for the process

`meter.ts`, next to `store.ts`, is where the host reads the environment for metrics:

```ts
import process from "node:process";
import { createMetrics, otlp } from "copilotz/exporters";

export function openMeter(env: Record<string, string | undefined> = process.env) {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return createMetrics({
    resource: { "service.name": "compass" },
    exporters: endpoint ? [otlp({ url: endpoint })] : [],
    interval: 15_000,
  });
}
```

`createMetrics` aggregates in the process, with web standards only. `resource` says who's measured
(`service.name`). An exporter sends what the meter holds on a timer, every `interval` (60 seconds
unless you say; here, 15), and the timer never keeps the process alive. `otlp({ url })` posts it to
an OpenTelemetry collector as OTLP/HTTP JSON (it adds `/v1/metrics` when the URL doesn't end in it),
so Grafana, Honeycomb, Datadog or any backend that takes OTLP can read Compass. A collector that's
down is logged, never a failure: the runtime goes on.

The terminal and the server make one meter each and pass it to `createRuntime` as `metrics`
(`terminal.ts`):

```ts
const me = you();
const tail = process.env.COMPASS_TAIL?.split(",").map(Number) as [number, number] | undefined;
const meter = openMeter();

const runtime = await createRuntime({
  ...(await openStorage()),
  metrics: meter,
  plugins: [
    ...plugins({ you: me, openai: process.env.OPENAI_API_KEY, tail }),
    metrics(meter),
    // … terminalPlugin, terminalShell, and the terminal front ends of chat, spaces, boards,
    // documents, memory, skills and routines
    metricsTerminal(meter),
  ],
});
// …
await runtime.close();
await meter.close();
```

`meter.close()` exports one last time and stops the timer. The server does the same, closing the
meter after the runtime when you stop it.

### Reading it: `/metrics`

Prometheus pulls: a scraper asks an address for the numbers, as text. Copilotz's `exposition(meter)`
is that answer, a fetch handler; Compass serves it from a small plugin of its own,
`plugins/metrics`. A plugin that needs the meter is made from it, as a function (`mod.ts`):

```ts
export function metrics(meter: Meter): Plugin {
  return definePlugin({
    name: "metrics",
    requires: ["identity"],
    routes: { "/metrics": metricsRoute(meter) },
  });
}
```

`Meter` (`contract.ts`) is what the plugin needs of it: a meter that records, and says what it
holds.

```ts
export type Meter = Metrics & { collect(): Snapshot };
```

The route (`routes/metrics.ts`) answers you alone. It asks no one new who a request is: identity's
`who` already says a request from this machine is you, and anything else nobody. A Prometheus
running on this machine is you too.

```ts
export function metricsRoute(meter: Meter): Route {
  const scrape = exposition(meter);
  return (request, { actor }) => {
    if (request.method !== "GET") return new Response("Only GET", { status: 405 });
    if (actor.kind !== "person") return new Response("Only from this machine", { status: 401 });
    return scrape();
  };
}
```

The text is Prometheus's exposition format (`text/plain; version=0.0.4`): names become Prometheus's,
dots to underscores (`copilotz.job.duration` is `copilotz_job_duration`), counters end in `_total`,
and a histogram is its buckets, its `_sum` and its `_count`, each line with its attributes as
labels.

### Reading it in the terminal

`plugins/metrics/terminal.ts` adds `/metrics [name]`, a `commands` resource like `/board`:

```ts
export function commandsFor(meter: Meter): Commands {
  return {
    "/metrics": command({
      description: "What's been measured, as Prometheus text; a name narrows it",
      usage: "[name]",
      async run(args, term) {
        const name = args.trim();
        // The values, without the help lines and the histograms' buckets.
        const lines = text(meter.collect()).split("\n").filter((line) =>
          line && !line.startsWith("#") && !line.includes("_bucket{") &&
          (!name || line.includes(name))
        );
        await term.print(lines.join("\n") || "Nothing measured yet.");
      },
    }),
  };
}
```

`text` is what `exposition` answers with, as a function: the same lines, without HTTP.

Copilotz has no plugin of its own for this (each plugin instruments itself, and the host says where
measurements go), so unlike the plugins you rebuilt, this one has no parity test: there's nothing of
Copilotz's to compare it with.

## Run it

```sh
printf 'Hi North\n/metrics gen_ai\n/metrics copilotz_job_duration_count\n/quit\n' | COMPASS_ME=ana \
  COMPASS_DATA=.data/l122/compass.sqlite OPENAI_API_KEY= \
  node --disable-warning=ExperimentalWarning terminal.ts
```

```text
Compass
Ana → north › Hi North
north › You said: Ana: Hi North
ana › /metrics gen_ai
gen_ai_client_operation_duration_sum{gen_ai_operation_name="embeddings",gen_ai_p
rovider_name="hash",gen_ai_request_model="words"} 0.0006370410000000675
gen_ai_client_operation_duration_count{gen_ai_operation_name="embeddings",gen_ai
_provider_name="hash",gen_ai_request_model="words"} 1
gen_ai_client_operation_duration_sum{gen_ai_operation_name="chat",gen_ai_provide
r_name="fake",gen_ai_request_model="echo"} 0.09285429099999999
gen_ai_client_operation_duration_count{gen_ai_operation_name="chat",gen_ai_provi
der_name="fake",gen_ai_request_model="echo"} 1
copilotz_llm_time_to_first_token_sum{gen_ai_operation_name="chat",gen_ai_provide
r_name="fake",gen_ai_request_model="echo"} 0.016860083000000033
copilotz_llm_time_to_first_token_count{gen_ai_operation_name="chat",gen_ai_provi
der_name="fake",gen_ai_request_model="echo"} 1
ana › /metrics copilotz_job_duration_count
copilotz_job_duration_count{kind="call",name="person.set",outcome="ok"} 1
copilotz_job_duration_count{kind="call",name="space.personal",outcome="ok"} 1
copilotz_job_duration_count{kind="query",name="shell.mine",outcome="ok"} 2
copilotz_job_duration_count{kind="call",name="shell.set",outcome="ok"} 2
copilotz_job_duration_count{kind="query",name="message.questions",outcome="ok"}
1
copilotz_job_duration_count{kind="process",name="compass.title",outcome="ok"} 1
copilotz_job_duration_count{kind="call",name="chat.send",outcome="ok"} 1
copilotz_job_duration_count{kind="process",name="history.compact",outcome="ok"}
2
copilotz_job_duration_count{kind="process",name="chat.turn",outcome="ok"} 1
copilotz_job_duration_count{kind="call",name="shell.print",outcome="ok"} 3
```

Two model calls, both offline: memory's embedding of what you said, to recall by (`hash/words`), and
North's answer (`fake/echo`), in 0.09 seconds, its first piece after 0.017. And every job of the
turn: your `chat.send`, North's turn (`chat.turn`, a Processor), the title (`compass.title`),
history's `history.compact` (once for each message), and the terminal's own calls. With
`npm run dev`, the same text is at http://127.0.0.1:8080/metrics for a Prometheus on this machine to
scrape; with `OTEL_EXPORTER_OTLP_ENDPOINT` set, it also goes to that collector every 15 seconds.

## Check it

`plugins/metrics/tests/metrics.test.ts` starts Compass with a meter, takes one turn of North's, and
reads the numbers both ways. Through `runtime.fetch` (no port), a request from `127.0.0.1` gets a
200 with Prometheus's content type, `copilotz_job_duration` as a histogram with its counts, and
`gen_ai_client_operation_duration`; one from `192.168.1.20` gets a 401. And in the terminal,
`/metrics gen_ai` prints the model call's lines and none of the jobs'.

```text
✔ after a turn, /metrics answers Prometheus text, to this machine alone
✔ /metrics in the terminal prints the numbers, narrowed by a name
```

## Also in this chapter

- `.env.example`: `OTEL_EXPORTER_OTLP_ENDPOINT=`, with a comment (`http://localhost:4318`, a
  collector's usual OTLP/HTTP address).
- `server.ts`: the same meter, the `metrics(meter)` plugin before the page, and `meter.close()`
  after the runtime when you stop it.
- `terminal.ts`: its doc comment names `/metrics`.
- `tests/store.test.ts`: the PostgreSQL test returns early when PGlite isn't installed, instead of
  failing (Chapter 36's `{ skip }` is an option `copilotz/testing`'s `test` doesn't take).

`git diff lesson-12.1 lesson-12.2` shows every change.

## What you have now

Compass you can watch: how long each job, commit and model call takes, and how many, at `/metrics`
or in the terminal, and in any OpenTelemetry backend you point it at. None of it was written into
Compass's plugins: Copilotz measures itself, and the host only says where the numbers go. Next, your
agents get a computer of their own to work on.
