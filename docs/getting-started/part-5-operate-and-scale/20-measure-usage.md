---
title: "Chapter 20: Measure Model and Tool Usage"
description: "Record a Usage ledger row for every model attempt and tool call on the chat host, and read bounded, authorized analytics over the existing HTTP boundary."
section: Getting Started
order: 200
status: stable
---

# Chapter 20: Measure Model and Tool Usage

> Part 5 — Operate and Scale · Track: H (optional) · Requires: Chapter 17 ·
> Needs: Deno 2.9+ or Node 24+, `OPENAI_API_KEY` for live traffic

## The pain

The assistant is live behind `serve-agent.ts`. People chat with it, it calls
`saveNote`, and the model provider sends you an invoice at the end of the month.
You cannot answer simple questions from inside your own application:

- How many model calls did this tenant make yesterday, and how many failed?
- Which connection and model consumed the input tokens?
- Is prompt caching doing anything, or does it only look like it?
- Did a fallback model quietly take over half the traffic?

Logging every model response to the console does not help. It prints too much,
leaks conversation content into logs and still misses failed or cancelled
attempts.

## The problem

Usage numbers are easy to get wrong:

- **One reply is not one model call.** A turn can retry, fall back to another
  model, be cancelled, or call tools between model steps. Counting only
  successful replies hides exactly the attempts you pay for or need to debug.
- **Missing is not zero.** Some providers or attempts do not report cache reads,
  or any token counts at all. Treating a missing number as `0` invents a cache
  miss and makes ratios meaningless.
- **Analytics is tenant-wide data.** A report over a tenant's ledger shows every
  user's traffic in that tenant. Being authenticated in the tenant, or knowing a
  thread ID, is not permission to see it.
- **The generic server stays generic.** `server.ts`, `auth.ts` and the Runtime
  tests must not learn about Usage, just as they did not learn about Core.

## The solution

Usage comes in two public entries. The host imports the plugin and its HTTP
adapter from `@copilotz/copilotz/usage`; callers import the client and its
response types from the browser-safe `@copilotz/copilotz/usage/client`:

- `usagePlugin` is a reusable Runtime plugin that consumes model and tool
  lifecycle Events. In this tutorial Core produces them. It writes one ledger
  record per finalized **provider request** that reports accounting
  (`kind: "llm"`), including failed, fallback and cancelled requests when their
  accounting is supplied, and one per **tool execution** (`kind: "tool"`). Token
  counts are the metrics the provider reported, never estimates from text
  length; anything not reported stays `null`, and a provider may report none.
- `createUsageHttpAdapter()` mounts two read routes, by default at `/usage` and
  `/usage/attempts`, with the stable route IDs `copilotz.usage.analytics` and
  `copilotz.usage.attempts`. Behind the facade's `/api` base they become
  `/api/usage` and `/api/usage/attempts`. Every query reads through the
  request's trusted scope; the query cannot select another namespace or schema.
- `createUsageClient()`, from `@copilotz/copilotz/usage/client`, is a small
  Fetch client for those routes. Its default base URL is `/api/admin/usage`,
  which does **not** match this host, so the report script passes
  `http://127.0.0.1:8000/api/usage` explicitly.

Before you add code, you need what Chapter 17 built:

- `serve-agent.ts` (or `serve-agent-node.ts`) serving the assistant with
  `agent.ts`, `composition.ts`, Core and `coreHttpPlugin`;
- the Chapter 17 `auth.ts`, whose `http` case allows only route IDs listed in
  the principal's `allowedHttpEndpointIds`;
- the Chapter 17 `server.ts`, which already accepts `plugins` and `adapters`.

Neither `auth.ts` nor `server.ts` changes. The routes are closed by default
deny; this chapter grants them to one trusted principal in the host.

### Replace `serve-agent.ts`

Replace `serve-agent.ts` with this complete file. Compared with Chapter 17 it
makes four changes: it imports the Usage package, appends `usagePlugin` after
Core's plugins, registers the Usage adapter as `adapters.http.usage`, and grants
the two Usage route IDs to `localUser`. Every Chapter 17 declaration, grant and
lifecycle step is kept.

```ts
// Core's optional HTTP projection: the send Action and the `http.core` adapter.
import { coreHttpPlugin } from "@copilotz/copilotz/core/server";
// The Usage ledger plugin and its two read routes.
import { createUsageHttpAdapter, usagePlugin } from "@copilotz/copilotz/usage";
// Host composition: Core, tools, the model connection and the assistant. This
// import reads the credential.
import { agentPlugins, agentResources } from "./agent.ts";
// The same host choices as `app.ts`.
import { database, namespace, runtimePlugins } from "./composition.ts";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";

// Local demo credential: a fixed string checked by exact match.
const devAuthorization = "Bearer local-dev-token";

// The same local demo identity as Chapter 17. As the only operator of this
// local tenant, it may also read the tenant's Usage analytics.
const localUser: Principal = {
  actorId: "local-guide-user",
  namespace,
  allowedActionIds: ["notes.save", "copilotz.core.conversation.send"],
  allowedHttpEndpointIds: [
    // Core's conversation reads, each limited by Core to this actor's threads.
    // `core.threads.observe` is deliberately not granted.
    "core.threads.list",
    "core.threads.get",
    "core.threads.messages",
    "core.threads.message-asset",
    // Tenant-wide Usage reads. Grant these only to principals allowed to see
    // every user's traffic in this namespace.
    "copilotz.usage.analytics",
    "copilotz.usage.attempts",
  ],
};

const app = await createServerApp({
  // Exact match only; any other or missing header resolves to no principal.
  resolvePrincipal: (request) =>
    request.headers.get("authorization") === devAuthorization
      ? localUser
      : undefined,
  namespace,
  database,
  // Runtime plugins, the agent harness, Core's HTTP projection, then the
  // Usage ledger. Shared plugin objects are registered once.
  plugins: [...runtimePlugins, ...agentPlugins, coreHttpPlugin, usagePlugin],
  // Agents, model connections and tools that Core reads.
  resources: agentResources,
  // The Usage read routes, mounted under the facade as `/api/usage`.
  // `coreHttpPlugin` still registers `http.core` itself.
  adapters: { http: { usage: createUsageHttpAdapter() } },
  // Publish the send Action. Update, delete and edit stay unpublished.
  publicActionIds: ["copilotz.core.conversation.send"],
});

// Set once the listener starts, so a signal can shut it down gracefully.
let server: Deno.HttpServer | undefined;
const stop = () => void server?.shutdown();

try {
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);

  server = Deno.serve({
    // Accept loopback connections only.
    hostname: "127.0.0.1",
    port: 8000,
    onListen: ({ hostname, port }) =>
      console.log(`Notes chat API on http://${hostname}:${port}/api`),
  }, app.fetch);

  // Resolves after `shutdown()` has let pending requests finish.
  await server.finished;
  console.log("listener stopped");
} finally {
  // Always remove the handlers and release the database, even after a
  // startup failure.
  Deno.removeSignalListener("SIGINT", stop);
  Deno.removeSignalListener("SIGTERM", stop);
  await app.close();
}
```

The grant lives on the principal, not in `auth.ts`, so other authenticated
callers in the same tenant still get `403` from both routes. In production your
`resolvePrincipal` adds the two IDs only for users your identity system marks as
tenant analysts. If ordinary users should see only their own usage, do not grant
these routes; build a separate route that adds the actor filter on the server
instead of trusting a `threadId` or `agentId` from the query string. Those IDs
are reporting dimensions, not authorization boundaries.

### Replace `serve-agent-node.ts`

On Node, replace `serve-agent-node.ts` with this complete file. It makes the
same four changes.

```ts
// Bridges a Node HTTP listener to a Fetch handler.
import { serve } from "@hono/node-server";
// Shutdown signals.
import process from "node:process";
// Core's optional HTTP projection: the send Action and the `http.core` adapter.
import { coreHttpPlugin } from "@copilotz/copilotz/core/server";
// The Usage ledger plugin and its two read routes.
import { createUsageHttpAdapter, usagePlugin } from "@copilotz/copilotz/usage";
// Host composition: Core, tools, the model connection and the assistant. This
// import reads the credential.
import { agentPlugins, agentResources } from "./agent.ts";
// The same host choices as `app.ts`.
import { database, namespace, runtimePlugins } from "./composition.ts";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";

// Local demo credential: a fixed string checked by exact match.
const devAuthorization = "Bearer local-dev-token";

// The same local demo identity as Chapter 17. As the only operator of this
// local tenant, it may also read the tenant's Usage analytics.
const localUser: Principal = {
  actorId: "local-guide-user",
  namespace,
  allowedActionIds: ["notes.save", "copilotz.core.conversation.send"],
  allowedHttpEndpointIds: [
    // Core's conversation reads, each limited by Core to this actor's threads.
    // `core.threads.observe` is deliberately not granted.
    "core.threads.list",
    "core.threads.get",
    "core.threads.messages",
    "core.threads.message-asset",
    // Tenant-wide Usage reads. Grant these only to principals allowed to see
    // every user's traffic in this namespace.
    "copilotz.usage.analytics",
    "copilotz.usage.attempts",
  ],
};

const app = await createServerApp({
  // Exact match only; any other or missing header resolves to no principal.
  resolvePrincipal: (request) =>
    request.headers.get("authorization") === devAuthorization
      ? localUser
      : undefined,
  namespace,
  database,
  // Runtime plugins, the agent harness, Core's HTTP projection, then the
  // Usage ledger.
  plugins: [...runtimePlugins, ...agentPlugins, coreHttpPlugin, usagePlugin],
  // Agents, model connections and tools that Core reads.
  resources: agentResources,
  // The Usage read routes, mounted under the facade as `/api/usage`.
  adapters: { http: { usage: createUsageHttpAdapter() } },
  // Publish the send Action. Update, delete and edit stay unpublished.
  publicActionIds: ["copilotz.core.conversation.send"],
});

// Set by the listener lifecycle below; the `finally` block removes them.
let stop = () => {};
let fail = (_error: Error) => {};
let server: ReturnType<typeof serve> | undefined;

try {
  // Accepts loopback connections and forwards every request to `app.fetch`.
  const listener = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port: 8000 },
    (info) =>
      console.log(`Notes chat API on http://127.0.0.1:${info.port}/api`),
  );
  server = listener;

  // Resolves once a signal has closed the listener; rejects on a listener
  // failure, such as the port being in use.
  await new Promise<void>((resolve, reject) => {
    stop = () => listener.close((error) => (error ? reject(error) : resolve()));
    fail = reject;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    listener.on("error", fail);
  });
  console.log("listener stopped");
} finally {
  // Always remove the handlers and release the database.
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  server?.off("error", fail);
  await app.close();
}
```

### How attempts become rows

Each finalized provider request inside an `llm.call` Action that reports
accounting produces one `llm` row with its connection, model, status and
reported metrics. A turn that falls back from one model to another usually shows
a `failed` row and a `completed` row. A cancelled turn shows a `cancelled` row
only if a provider request was finalized with accounting before the
cancellation; that is not guaranteed. Each tool execution, such as `saveNote`,
produces its own `tool` row. Rows carry the agent and thread as attribution, so
you can compare by `connection`, `model`, `agentId` or `threadId`.

The `analytics` route returns a `summary` over the whole selection, a `series`
per time bucket and a `breakdown` per group. These are three views of the same
rows: add up one of them, never two, and never add `summary` to a sum of attempt
rows. `llm` and `tool` are separate selections, so query them separately rather
than combining their counts.

The Usage Processors inherit the operation's settlement; they are not detached.
Streamed reply text can reach a client before the rows are written, so a query
made while a turn is still running can miss its rows. Once Chapter 17's
observation reports `operation.completed`, the recording handlers for that turn
have finished. If recording fails, it can fail the operation instead of silently
losing a row. A host's `onRecord` hook or disabled config can still drop rows on
purpose. Recording costs database writes per attempt and query load per report,
which is why every query is bounded: a time range of at most 366 days (31 for
hourly buckets), at most two group dimensions, and at most 200 attempts per
page.

### Create `usage-report.ts`

`usage-report.ts` is a client **entrypoint**, like `chat-client.ts`. It imports
only `@copilotz/copilotz/usage/client`, the browser-safe client entry that also
exports the response types. It never imports the plugin package
`@copilotz/copilotz/usage`, and never imports `agent.ts`, `server.ts` or a
credential module. It takes optional `from` and `to` ISO timestamps and
otherwise reports the last 24 hours.

It prints counts and token totals, shows unreported metrics as `unknown`, and
prints cache reuse only together with its coverage: `cacheReuse` is computed
over the attempts that reported both input and cache-read tokens, not over all
input tokens. It then pages through attempt rows explicitly, with a hard cap on
how many it prints, and prints IDs and numbers only, never prompts or replies.

```ts
// Browser-safe Fetch client and response types for the Usage read routes.
import { createUsageClient } from "@copilotz/copilotz/usage/client";
import type {
  UsageFilters,
  UsageMetrics,
} from "@copilotz/copilotz/usage/client";
// Command-line input and the exit status.
import process from "node:process";

// The facade's `/api` base plus the adapter's `/usage` path. The client's own
// default, `/api/admin/usage`, does not exist on this host.
const usage = createUsageClient({
  baseUrl: "http://127.0.0.1:8000/api/usage",
  getRequestHeaders: () => ({ authorization: "Bearer local-dev-token" }),
});

// Attempt rows per request, and the most this script will print in total.
const pageSize = 50;
const maxRows = 200;

// A reported number, or `unknown` when no attempt reported it.
const show = (value: number | null) => value === null ? "unknown" : `${value}`;
// A fraction as a percentage, or `unknown`.
const percent = (value: number | null) =>
  value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;

// Prints the counters and reported metrics of one summary or breakdown entry.
function printMetrics(label: string, metrics: UsageMetrics) {
  console.log(
    `${label}: attempts ${metrics.attempts} ` +
      `(completed ${metrics.completed}, failed ${metrics.failed}, ` +
      `cancelled ${metrics.cancelled})`,
  );
  console.log(
    `  input tokens ${show(metrics.inputTokens)} ` +
      `(reported by ${metrics.inputReported}), ` +
      `output tokens ${show(metrics.outputTokens)}`,
  );
  // Cache reuse covers only attempts that measured both input and cache reads.
  console.log(
    `  cache reuse ${percent(metrics.cacheReuse)} over ` +
      `${metrics.cacheReported} measured attempts ` +
      `(coverage ${percent(metrics.cacheCoverage)})`,
  );
}

// Parses an optional ISO timestamp argument.
function timestamp(value: string | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Not an ISO timestamp: ${value}`);
  }
  return parsed.toISOString();
}

async function report(from: string, to: string): Promise<number> {
  console.log(`usage from ${from} to ${to} (UTC)`);

  // Model attempts, grouped by connection and model, in daily buckets.
  const llmFilters: UsageFilters = { kind: "llm", from, to };
  const llm = await usage.analytics({
    filters: llmFilters,
    groupBy: ["connection", "model"],
    interval: "day",
  });
  printMetrics("model attempts", llm.summary);
  for (const entry of llm.breakdown) {
    const { connection, model } = entry.dimensions;
    printMetrics(`  ${connection ?? "unknown"} / ${model ?? "unknown"}`, entry);
  }

  // Tool executions are a separate selection; their counts are not added to
  // model attempts.
  const tools = await usage.analytics({
    filters: { kind: "tool", from, to },
    groupBy: ["resource"],
  });
  for (const entry of tools.breakdown) {
    console.log(
      `tool ${entry.dimensions.resource ?? "unknown"}: ` +
        `attempts ${entry.attempts}, failed ${entry.failed}`,
    );
  }

  // Individual model attempts, newest first, one bounded page at a time.
  let after: string | undefined;
  let printed = 0;
  do {
    const page = await usage.attempts({
      filters: llmFilters,
      limit: pageSize,
      after,
    });
    for (const attempt of page.items) {
      console.log(
        `${attempt.occurredAt} ${attempt.status ?? "unknown"} ` +
          `${attempt.connection ?? "unknown"}/${attempt.model ?? "unknown"} ` +
          `in ${show(attempt.inputTokens)} out ${show(attempt.outputTokens)} ` +
          `cached ${show(attempt.cachedInputTokens)}`,
      );
      printed += 1;
    }
    after = page.pageInfo.next ?? undefined;
  } while (after && printed < maxRows);
  if (after) console.log(`stopped after ${printed} attempts; narrow the range`);
  return 0;
}

// Optional bounds; the default is the last 24 hours.
const [fromArg, toArg] = process.argv.slice(2);
try {
  const to = timestamp(toArg, new Date());
  const from = timestamp(
    fromArg,
    new Date(Date.parse(to) - 24 * 60 * 60 * 1000),
  );
  process.exitCode = await report(from, to);
} catch (error) {
  // Bad arguments, a refused route or an unreachable host. Only the message is
  // printed.
  console.error(
    `usage report failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
```

### Pricing is your policy

The ledger stores metered quantities. This chapter does not turn them into
money: provider prices change, and discounts, markups and currency are business
decisions. If you need a cost per row, the Usage plugin reads optional
`resolveCost` and `onRecord` hooks from the host's `adapters.usage.hooks`, and
`resources.usage.config.enabled: false` turns recording off. See the
[Usage reference](../../usage.md) before relying on them.

## Check it works

The live run sends real model traffic, so `OPENAI_API_KEY` must be set in the
host's environment, as in Chapter 17.

Start the host and send a chat message:

```sh
# Terminal 1: the chat host, now with the Usage ledger.
deno run -A serve-agent.ts
# Node 24+ alternative:
node serve-agent-node.ts

# Terminal 2: one chat turn, as in Chapter 17.
deno run --allow-net=127.0.0.1:8000 chat-client.ts "Save a note: measure usage." chat-020
```

Then read the report:

```sh
# Last 24 hours.
deno run --allow-net=127.0.0.1:8000 usage-report.ts
# Explicit bounds; Node 24+ takes the same arguments.
node usage-report.ts 2026-10-05T00:00:00Z 2026-10-07T00:00:00Z
```

Expected facts, not exact text:

- at least one `model attempts` entry for the `openai` connection and
  `gpt-5.4-mini`; token figures appear where the provider reported them,
  otherwise `unknown`;
- if the assistant chose to call `saveNote`, a `tool saveNote` line, and more
  than one model attempt for that turn, because the model ran before and after
  the tool;
- a cache reuse figure that is `unknown` or anything from 0% up. Caching is the
  provider's decision; nothing guarantees a hit;
- one line per attempt, at most 200 in total.

Replies are nondeterministic, so the counts vary from run to run. Run the report
after `chat-client.ts` exits with status 0. By then the operation has completed,
so that turn's recorded rows are already queryable. No sleep or retry is needed.

Authorization stays closed for everyone else. Without the `authorization` header
the routes answer `401`; a principal in the same tenant whose
`allowedHttpEndpointIds` lacks the Usage IDs gets `403`. The Chapter 16 server
tests run unchanged, with no Core, no Usage and no credential.

Stop the host with Ctrl+C.

## What this unlocks

- Failed, cancelled and fallback attempts are visible next to successful ones,
  so a silent fallback or a failing connection shows up in numbers.
- Reported token counts per connection and model give you baselines to compare
  models, prompts and Memory or Skill settings over time.
- Cache reuse comes with its coverage, so you can tell "no cache hits" from "not
  measured".
- A pricing policy can be added explicitly, on your terms, on top of the same
  ledger.

## Next steps

- Next (Runtime track): [Chapter 21: Deploy and Scale](21-deploy-and-scale.md)
  runs gateway and worker roles on shared persistence. It requires Chapter 7,
  and Chapter 15 for the Fetch boundary.
- Reference: [Usage](../../usage.md) covers ledger fields, hooks and query
  limits.
- Reference: [Models](../../models.md) covers connections, fallback and
  provider-reported metrics.
- Reference: [Testing and inspection](../../testing-and-inspection.md) covers
  scripted model adapters for deterministic usage checks.
