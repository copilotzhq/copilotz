---
title: "Usage"
description: "Record a durable ledger row per finalized model provider request and tool execution, price it with your own policy, and read bounded, scoped analytics over HTTP."
section: Operate
order: 30
status: stable
---

# Usage

## The pain

Your agent host is in production. The provider invoice arrives, a tenant asks
why their bill doubled, and you suspect a fallback model quietly took over. You
need answers from your own data: which connection, model, agent and thread
consumed what, which attempts failed, and whether prompt caching helps. Printing
model responses to logs leaks conversation content and still misses failed,
retried and cancelled attempts.

## The problem

You need a ledger contract that is honest about what it knows:

- **What is one row?** A turn can retry, fall back, call tools and be cancelled.
  Counting replies hides the attempts you pay for.
- **What does missing mean?** Providers may omit token or cache counts. A
  missing value recorded as `0` invents a cache miss and corrupts ratios.
- **Who owns price?** Provider prices, discounts and currency change; the ledger
  must not pretend to know them.
- **Who may read it?** Tenant analytics show every user's traffic in that
  namespace. Authentication, or knowing a thread ID, is not permission.

## The solution

Usage is a reusable Runtime plugin with two public entries:

| Entry                             | Exports used here                                                                                                                                    | Who imports it                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `@copilotz/copilotz/usage`        | `usagePlugin`, `createUsageHttpAdapter`, `METRIC_DESCRIPTORS`, types `UsageResolveCost`, `UsageOnRecord`, `UsageOptions`, `UsageRecord`, `UsageCost` | the host                                           |
| `@copilotz/copilotz/usage/client` | `createUsageClient`, types `UsageFilters`, `UsageMetrics`, `UsageAnalytics`, `UsageAttemptPage`                                                      | browser-safe report clients; no server code pulled |

Query types such as `UsageFilters` and `UsageMetrics` are exported from
`/usage/client`, not from `/usage`.

### Producer and ledger are separate

`usagePlugin` does not call models and does not depend on Core. It reacts to
lifecycle Events of the generic `llm.call` Action, which the LLM capability
plugin provides, and to Core tool lifecycle Events, then writes rows to its
`usage` Collection. Any `llm.call` that reports attempt accounting is recorded;
when Core invokes it, Core's call metadata adds agent and thread attribution,
otherwise the row is unattributed. Tool rows come from a separate producer:
Core's tool lifecycle metadata. Arbitrary Actions you write are not metered as
tools. Without a producer, the ledger stays empty.

What becomes a row:

- **`llm`**: one row per finalized provider attempt that actually sent a
  provider request, keyed by the Action run and attempt index. Completed,
  failed, fallback and cancelled attempts appear **when their accounting was
  finalized**; the ledger never fabricates a row for an attempt that never
  reported. A fallback turn usually shows a `failed` row and a `completed` row.
- **`tool`**: one row per Core tool execution, such as `saveNote`.

The `UsageKind` type also names `asset`, `rag` and `embedding`, but nothing
meters those automatically today.

Metrics the built-in recorders write:

- `llm` rows: the token counts the provider reported (`inputTokens`,
  `outputTokens`, `reasoningTokens`, `cachedInputTokens`,
  `cacheCreationInputTokens`, `totalTokens`) plus `calls: 1`. An unreported
  token count is `null`, never `0`, and never estimated from text length.
- `tool` rows: `calls: 1`.
- `durationMs` is not populated by either recorder. The query side can aggregate
  it, but it stays unknown unless your host adds a measurement.

An `onRecord` hook can transform metrics, so a stored value is the producer's
report as your host policy left it. Attribution (`agentId`, `threadId`,
`messageId`, `initiatedById`) comes from Core's call metadata when present.

### Recording is part of the operation

The Usage Processors inherit the operation's settlement; they are not detached.
Streamed reply text can reach a client before the rows exist. Once the operation
reports completed, rows for that turn's valid accounting are written, unless
recording is disabled with `resources.usage.config.enabled: false` or your
`onRecord` hook returned `null`; then no row is expected. A recording failure
can fail the operation rather than silently lose a row. Hooks run before
persistence, so they may run again when the delivery is retried; keep them
deterministic and free of external side effects.

### Worked example: a host pricing policy

The ledger keeps any cost the producer already reported and adds no pricing
catalog of its own. If you want cost per row, supply it as host policy. This
example builds on
[Chapter 20](getting-started/part-5-operate-and-scale/20-measure-usage.md),
which already composes `usagePlugin` and the HTTP adapter in `serve-agent.ts`.

Create `usage-policy.ts`. It is pure: rates are constants you maintain, and no
environment or network is read.

> **Replace the rates.** The figures below are placeholders, not provider
> prices. The policy is deliberately simplified: one input rate and one output
> rate per model. It does not price cached or cache-creation tokens differently
> and does not add reasoning tokens separately, so it cannot double count them.
> If your contract has those tiers, encode them explicitly.

```ts
// Hook types from the host-side Usage entry.
import type { UsageOnRecord, UsageResolveCost } from "@copilotz/copilotz/usage";

// Your contracted rates in USD per million tokens, keyed by the provider model
// your connection selects. Placeholders: replace them with your actual contract.
const usdPerMillion: Readonly<
  Record<string, { input: number; output: number }>
> = {
  "gpt-5.4-mini": { input: 0.25, output: 2 },
};

// Prices model rows from reported tokens with a uniform input/output policy.
// Without a rate or reported tokens, it keeps a producer-supplied cost only
// when that cost is already in USD; anything else stays uncosted.
export const resolveCost: UsageResolveCost = async (
  event,
  { defaultResolve },
) => {
  const rate = event.kind === "llm" && event.model
    ? usdPerMillion[event.model]
    : undefined;
  const input = event.metrics.inputTokens;
  const output = event.metrics.outputTokens;
  if (!rate || input === undefined || output === undefined) {
    const fallback = await defaultResolve();
    return fallback?.currency === "USD" ? fallback : null;
  }
  const inputCostUsd = (input * rate.input) / 1_000_000;
  const outputCostUsd = (output * rate.output) / 1_000_000;
  return {
    currency: "USD",
    total: inputCostUsd + outputCostUsd,
    breakdown: { inputCostUsd, outputCostUsd },
    source: "custom",
  };
};

// Final hook before the row is written. It keeps every row but removes the
// whole `raw` block: the provider usage payload and the recorder's metadata
// such as its source marker and stop sequence. The stable `id` is unchanged.
export const onRecord: UsageOnRecord = (record) => ({
  ...record,
  raw: undefined,
});
```

A fallback cost in a currency other than USD is left uncosted instead of being
stored as if it were dollars. The policy performs no exchange-rate conversion;
add one explicitly if you need it.

Wire the hooks with two additive edits in `serve-agent.ts` (and the same two in
`serve-agent-node.ts`). First, **insert** this import next to the other local
imports:

```ts
// Host pricing and retention policy for Usage rows.
import { onRecord, resolveCost } from "./usage-policy.ts";
```

Second, inside the `adapters` object of the `createServerApp({...})` call,
**insert** this property after the existing `http` entry. Keep `http.usage` and
every other adapter you already register:

```ts
// Policy hooks the Usage Processors read before each write.
usage: { hooks: { resolveCost, onRecord } },
```

Rules the hooks follow:

- `defaultResolve()` returns the producer-supplied cost, normalized, or `null`.
  There is no built-in price list.
- The stored `totalCostUsd` column receives `cost.total` **without currency
  conversion**. Keep one currency (USD) across every resolver, or that column
  mixes units.
- `onRecord` may transform a row or return `null` to drop it. Changing `id`
  throws, which fails recording.
- `resources.usage.config.enabled: false` disables recording and hooks.
- Hooks can run again when a delivery is retried, so keep them deterministic.

To check the policy, repeat Chapter 20's run: one chat turn, then
`usage-report.ts`. The counts are unchanged. Model attempt rows for a priced
model now carry a USD `totalCostUsd`, and other rows carry a USD cost or none.
The built-in analytics and attempts endpoints currently expose counts and token
metrics, not the stored cost fields. To inspect costs, use a host-authorized
Collection read or application query over the Usage ledger; the Chapter 20
report itself does not display them. You can also test `resolveCost` directly
with a hand-built `llm` event lacking a rate or token count and a
`defaultResolve` returning a non-USD cost: it yields `null` without a model
call.

### Reading analytics

`createUsageHttpAdapter()` mounts two read routes, `/usage` and
`/usage/attempts`, with route IDs `copilotz.usage.analytics` and
`copilotz.usage.attempts`. Behind a server facade with an `/api` base they are
`/api/usage` and `/api/usage/attempts`. Grant both IDs only to principals your
identity system trusts with tenant-wide data. Every query reads through the
request's trusted scope; `namespace`, `schema` or `databaseSchema` query
parameters are rejected.

`createUsageClient()` defaults its base URL to `/api/admin/usage`, which does
not match the adapter's routes above. Always pass `baseUrl` explicitly, for
example `http://127.0.0.1:8000/api/usage`, as Chapter 20's `usage-report.ts`
does. No Admin package is needed.

## Reference

Query limits, enforced on the server:

| Setting         | Contract                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `kind`          | `"llm"` or `"tool"`, one per query; an attempt count means model requests or tool executions respectively |
| `from` / `to`   | ISO timestamps over `occurredAt`; route default is the last 7 days                                        |
| Range           | positive, at most 366 days; `interval: "hour"` at most 31 days                                            |
| `interval`      | `hour`, `day` (default) or `week`, bucketed in UTC                                                        |
| `groupBy`       | one or two of `provider`, `model`, `connection`, `resource`, `agentId`, `threadId`                        |
| Attempt `limit` | 1–200, default 50; pass `pageInfo.next` as `after`                                                        |
| Attempt order   | newest by record creation time, not `occurredAt`                                                          |

Reading `UsageMetrics`:

- `summary`, `series` and `breakdown` are three views of the same rows. Sum one
  of them, never two, and never add `summary` to attempt rows.
- Model and tool counts measure different kinds of work, so read each in its own
  query. Cost totals from both may be added when every row uses the same
  currency.
- `inputReported`, `durationReported` and `cacheReported` count attempts that
  reported the metric; a token total of `null` means none did.
- `cacheReuse` is `cacheMeasuredReadTokens / cacheMeasuredInputTokens`, over
  only attempts that reported both input and cache reads. Always show it with
  `cacheCoverage`, the fraction of attempts that were measured. Caching remains
  the provider's decision.
- `threadId` and `agentId` are reporting dimensions, not authorization. For
  per-user views, build a route that applies the actor filter on the server.

## What this unlocks

- Fallbacks, failing connections and cancelled attempts show up in numbers.
- Token baselines per connection and model let you compare prompts, Memory and
  Skill settings over time.
- Cost becomes an explicit, testable host policy instead of a stale price table.
- Scoped, bounded reads make analytics safe to expose to tenant operators.

## Next steps

- [Chapter 20: Measure Model and Tool Usage](getting-started/part-5-operate-and-scale/20-measure-usage.md)
  composes the ledger and runs `usage-report.ts`.
- [Models](models.md) covers connections, fallback and provider metrics.
- [Testing and inspection](testing-and-inspection.md) covers scripted model
  adapters for deterministic usage checks.
- [Server](server.md) covers route IDs, principals and default deny.
