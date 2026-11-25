---
title: "Topology and runtimes"
description: "Where the owner, its executors, plugins' workers and browsers run, one instance per store and what a second one does, what a turn costs, many runtimes behind one address, and the JavaScript runtimes Copilotz runs on."
section: Architecture
order: 6
---

# Topology and runtimes

The same code runs in one process or across many machines. Only where the pieces run changes.

## One owner, many executors

```text
                  ┌──────────────────────── owner ────────────────────────┐
executors ──────► │ commits every write · numbers events · runs Processors │ ──► store
plugins' workers ►│ keeps timers · applies the rules · keeps the caches    │
browsers ───────► └────────────────────────────────────────────────────────┘
                       Oxian: in-process, or a WebSocket at /oxian
```

- **In one process,** the default, `createRuntime` starts the owner and 1 executor, joined by
  Oxian's in-process transport. `executors` starts more.
- **Apart,** executors in other processes or machines connect over Oxian's WebSocket transport and
  present the owner's executor key, which the owner compares in constant time. An owner can run with
  no executors of its own and wait for them.
- **Plugins' workers** are programs that aren't plugin code but do a plugin's work: a computer
  running commands. A plugin declares the kind in its `workers`, with the Actions that admit one and
  hear it come and go. A worker connects as executors do, presenting `<kind>:<secret>`, and the
  kind's `admit` Action says who it is. Plugin code sends it jobs with `ctx.workers.dispatch`, or
  `ctx.workers.call` for one JSON answer. A worker that isn't connected fails with `offline`.
- **Browsers** connect the same way, as untrusted workers bound to one actor. See
  [the ways in](transports.md).

The example app shows each placement:

```sh
deno task chat                              # owner and executor in one process
deno task chat --listen=8787 --executors=0  # owner only; executors connect remotely…
deno task executor --port=8787              # …from other terminals, as many as you like
```

## One instance per store

A store has one owner, in one process. Executors and workers may be many; the owner may not. On a
platform that runs copies of a service, run one instance for each store: on Cloud Run, set the
service's maximum instances to 1. A deploy still starts the new revision beside the old one, and
`serve` with PostgreSQL's lease hands over between them (see
[Shipping the salon](../getting-started/10-shipping-the-salon.md)).

When a second process opens the store anyway (an instance the platform added, a deploy without the
lease, a script), it moves the store's epoch and becomes its owner. The first one finds out at its
next write, or within 5 seconds while idle: the owner checks its epoch whenever it hasn't committed
since its last check (`fenceCheck`, in ms, on `createRuntime`; `false` for a store no other process
can open). Then it stops serving, for good:

- every request gets a 503 with `retry-after: 5`: routes, webhooks, `/connect`, the API, `/health`,
  and sockets' upgrades;
- its sockets are moved off: browsers, executors and computers connect again a moment later, to
  whoever serves the address then;
- its executors and workers are let go, and its timers and Processors stop;
- nothing more goes to the store, not even the Processors' last positions (the new owner delivers
  from the positions saved, at least once, as after any stop);
- it logs one line, such as
  `copilotz: This owner was fenced: another owner holds the store (postgres schema "app") at epoch 8. It held epoch 7, and stopped serving: every request gets 503 from now on.`

Then `runtime.lost` resolves with the epoch it held and that line. What's left is the host's.
`serve` and `listen` from `copilotz/web/node` (serving `runtime.fetch` itself) stop listening and
exit the process with code 1, so the platform starts a new one; their `stopped` option says what to
do instead. With `Deno.serve`, say it yourself:

```ts
Deno.serve({ port: 8080 }, runtime.fetch);
runtime.lost.then(() => Deno.exit(1));
```

So a second instance costs seconds and delayed requests, not lost ones: senders that retry a 503
(webhook providers, browsers reconnecting) get through to the owner. Two instances that both stay up
still trade the store each time one starts, cutting each other's work, so it's a setting to fix, not
a way to run.

## What a turn costs

`deno task bench` measures the runtime's own cost per turn, with a scripted model that answers at
once. A plain turn, one agent answering one message, makes 3 round trips to the store, 2 jobs and 10
calls from executors to the owner.

| Where the executor runs        | Store  | Median | p95     |
| ------------------------------ | ------ | ------ | ------- |
| in the owner's process         | memory | 2.6 ms | 4.1 ms  |
| in the owner's process         | SQLite | 2.7 ms | 4.4 ms  |
| another process, over a socket | memory | 6.3 ms | 10.2 ms |

These are 50 turns each, on one laptop, on 2026-11-09. `--rtt=1.74` adds a delay to each round trip,
to see what a turn costs at production latency, and `--postgres=URL` runs it on PostgreSQL.

## Many runtimes behind one address

An app that serves many orgs gives each org a runtime of its own, with its own store and one writer.
A pool, `runtimes` from `copilotz`, opens one on its first use and closes it after 30 idle minutes,
and never runs 2 runtimes of one id at once. A directory runtime in front signs people in and sends
each request to its org's `runtime.fetch`. An org's runtime that loses its store answers 503 and
stays so, without exiting the process (its other orgs are still its own), until the pool opens it
again on its first use 30 minutes after the loss (`idleMs`). See
[many orgs behind one address](../guides/many-orgs.md) and
[the tenancy design](../../design/tenancy.md).

## Runtimes

Copilotz runs on Node first, then Deno and Bun. It's built on web standards for Cloudflare Workers
and the browser.

- **Library code uses web standards only:** fetch, streams, Web Crypto, `URL`, `AbortSignal`. What
  differs by runtime sits behind the runtime's ports: the store, blobs, and the transport.
- **The runtime is a fetch handler itself.** `Deno.serve` serves `runtime.fetch` as it is, and so
  does workerd. On Node and Bun, `listen` from `copilotz/web/node` serves it, sockets included.
- **Stores pick what the runtime has.** SQLite opens `node:sqlite` on Node and Deno and `bun:sqlite`
  on Bun, or any database with the same small API, such as a Durable Object's. PostgreSQL runs on
  Ominipg, against a server or PGlite in the process. File blobs use `node:fs`.
- **Nothing reads the environment.** A host passes configuration in.

One suite runs on all 3. Tests use `testing/mod.ts` for tests, temp files, a local server and child
processes, instead of a runtime's own APIs. CI runs the suite on Deno, Node and Bun against
PostgreSQL, and on Node on macOS and Windows. Front ends are `.tsx`: Deno and Bun run them as they
are, and Node runs the npm package's JavaScript.

Copilotz is published twice, from the same sources. JSR takes the TypeScript, as
`@copilotz/copilotz`. npm takes JavaScript with its types beside it, as `copilotz`.
