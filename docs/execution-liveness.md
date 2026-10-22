---
title: "Execution Liveness"
description: "How Copilotz detects stalled model calls by inactivity, the six-hour delivery safety ceiling and deliveryTimeoutMs, and what recovers interrupted work."
section: Runtime
order: 47
status: stable
---

# Execution liveness

Deliveries and worker-to-owner host calls use a six-hour safety backstop by
default. Worker session heartbeats renew delivery leases; provider activity
renews the LLM inactivity watchdog. Elapsed execution time is not treated as
proof that a worker or model has died.

Configure `deliveryTimeoutMs` on the application and every worker. Registered
Actions can declare a larger minimum using the same property:

```ts
const research = defineAction({
  id: "research.long",
  deliveryTimeoutMs: 8 * 60 * 60_000,
  async execute(input, context) {
    // Long-running work; observe context.signal for cancellation.
  },
});

const app = await createCopilotz({
  deliveryTimeoutMs: 6 * 60 * 60_000,
  actions: { research },
});
```

The effective backstop is the maximum of the application setting and every
registered Action's declared minimum. This is resolved before placement: a
parent delivery and its transport must allow a nested Action's duration before
that Action starts. This setting is a transport safety ceiling, not an
individual Action SLA. Timer values must be positive integers no larger than
`2^31 - 1` ms.

Distributed peers must use matching composition and configuration. Configure
`deliveryTimeoutMs` on shards too. Standalone `connectShardOwner` and
`connectShardDispatcher` uplinks use `hostCalls.timeoutMs`; their default is
also six hours. `shardOwnerCalls` accepts `deliveryTimeoutMs`, and the
dispatcher relay inherits its owner binding's timeout. The existing explicit
`calls.timeoutMs` shard override still takes precedence. On workers,
`hostCalls.timeoutMs` remains a fallback when `deliveryTimeoutMs` is omitted;
Action minima still apply.

The embedded dispatcher does not open host-call channels. Its existing local
execution cancellation and provider watchdogs remain in charge; the transport
backstop described here applies to distributed delivery placement.

## Provider liveness

All seven built-in providers run through the same bridge, including both OpenAI
Responses and Chat Completions, fallback attempts, and Ollama's JSONL stream.
Custom adapters own their own provider timeout behavior.

| Setting               | Default     | Meaning                                                            |
| --------------------- | ----------- | ------------------------------------------------------------------ |
| `firstTokenTimeoutMs` | 90 seconds  | No complete provider activity before visible content               |
| `streamIdleTimeoutMs` | 120 seconds | No complete provider activity after visible content                |
| `attemptTimeoutMs`    | 4 hours     | Absolute single-attempt safety backstop                            |
| `totalTimeoutMs`      | 5 hours     | Absolute logical-chat safety backstop across recovery and fallback |

These remain configurable LLM provider options; non-positive values disable the
corresponding provider timer. A quiet provider that emits no events while doing
long reasoning needs a larger first-activity window. Metadata, reasoning,
visible content, valid JSONL/SSE data, and complete SSE heartbeat comments renew
liveness. An incomplete byte fragment does not renew it indefinitely.

The watchdog covers request-body preparation, waiting for HTTP headers, stream
consumption, and the final usage drain after a local stop sequence. The bridge
disables the HTTP helper's separate five-minute header timer. Cancellation also
rejects stalled preparation and prevents it from issuing a late request.

A first-activity or idle failure retains its typed timeout kind internally and
surfaces **“The model stopped responding.”** through Action failure projection.
An absolute safety expiry has a distinct safety-backstop message. Both retain
the existing `llm_provider_timeout` retry classification; they are not user
cancellation. Tools still need tool-specific inactivity detection: a worker
heartbeat proves the worker is alive, not that a particular tool is progressing.

## Recovery and transport follow-up

Worker liveness uses accepted transport heartbeats, not an owner-side periodic
renewal independent of the worker. Session expiry revokes the active assignment
and its calls, stops SQL lease renewal, and allows owner delivery alarms to
recover the expired attempt. Completed provider results remain checkpointed by
Action effect identity; a recovered or duplicated delivery reuses the completion
receipt and full answer instead of issuing another paid call.

Oxian 0.23.1 fixes the stream deadline when opening a host call and exposes no
renewal API. Reissuing a call would lose the in-flight execution and is not a
safe renewal strategy. Copilotz therefore raises the safety ceilings without
pretending the installed transport timer is renewable.

A proposed Oxian change adds optional `idleTimeoutMs` to Oxian's worker and host
call settings. Delivered stream frames, successful writes, and
accepted/successfully written heartbeats would renew the idle window. Expiry
would have a typed `idle_timeout` code; late or discarded frames could not
resurrect a call. `timeoutMs` and explicit `deadlineAtMs` would remain absolute
upper bounds, and both peers would configure the idle window above their
heartbeat interval. The pinned Oxian 0.23.1 does not include it.

## Next steps

- [Owner recovery](owner-recovery.md): fenced owner replacement and lease timing
  on loaded hosts.
- [Events, deliveries and recovery](events-deliveries-recovery.md): retries,
  settlement and recovery of delivered work.
- [Models](models.md): provider connections and their request options.
