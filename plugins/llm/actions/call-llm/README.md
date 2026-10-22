# Call LLM

## What it is

The provider-neutral durable `llm.call` Action.

## Why it exists

It separates agent orchestration from individual model-provider protocols.

## How to use it

Compose `llmPlugin` and invoke the `callLlm` Action with configured model
aliases.

## How it works

It resolves model and credential Resources, streams the selected Adapter, and
records normalized output and attempts.

Tool-call stream lanes are speculative drafts. Copilotz validates the final Tool
declaration before accepting it or allowing Core to execute a Tool. A rejected
attempt may publish bounded, credential-safe diagnostic evidence as ordinary
Action progress; adapter authors must never include request content,
credentials, or provider error bodies in that evidence.

The Action declares `request.messages[].content` and
`request.messages[].reasoning` as runtime-managed input content. Its handler
receives metadata plus prepared values and never loads Asset bodies. An entry
with `resolve: false` is an intentional descriptor; the handler renders an
attachment notice rather than asking storage for its body. Core selects these
entries during its Collection read. Direct callers can supply prepared values or
explicit descriptors through the Action runtime.

Assistant reasoning is passed to built-in providers through the existing escaped
`<think>` formatter. Core supplies reasoning only for the target Agent's own
assistant history, not peer messages. Custom model adapters receive an optional
`reasoning` string on assistant messages.

The runtime stores reference-only invocation input, reuses existing content, and
restores prepared values on execution recovery. Calling `execute()` directly
bypasses that runtime boundary and therefore requires already-prepared entries.

Each provider candidate uses the Action's durable external-effect protocol. The
normalized completion is confirmed before stream draining, sealing, capture and
promotion. Delivery retries reuse that response, including text, tools,
reasoning and usage, without resolving credentials or calling the provider
again. Credential skips and permanent failures are retained too. A known
incomplete network/TLS/reset, provider timeout, HTTP 429 or 5xx attempt closes
its individual dispatch with a retry receipt. A later delivery uses a fresh
attempt step; it never rethrows that receipt as a permanent result. Before
dispatch, the Action checks all candidates for an already completed response,
including a fallback. Missing fallback credentials never replace the primary
provider error.

Explicit retryable failures leave the logical Action open until its retained
delivery budget is exhausted. Delivery scheduling applies bounded exponential
backoff and a Retry-After hint (seconds or HTTP date, capped at 30 seconds and
the configured retry cap). Backoff does not hold a worker slot. Permanent auth,
invalid-request and refusal errors settle immediately. Terminal failure text
identifies the provider problem and, after exhaustion, the delivery attempt
count.

An interrupted dispatch with no confirmed outcome remains indeterminate and is
never blindly repeated. A received incomplete response is retryable under this
policy; it cannot prove that the remote provider charged nothing. The completion
checkpoint follows the existing 1 MiB effect outcome limit; an oversized outcome
fails visibly instead of risking a duplicate completed request.

Physical stream incarnations belong to delivery attempts. Their failure does not
settle a chat reply: the feed waits for a durable Action or operation terminal.
A completion with neither nonempty content nor tools fails visibly. Captured
bodies must match the prepared length and digest before promotion.

Delivery dispatch and nested worker-to-owner calls have an explicit 15-minute
execution deadline. The worker factory also defaults its host-call budget to 15
minutes: Oxian otherwise clamps even explicit call deadlines to 30 seconds.
These budgets are independent of renewable delivery leases and the provider's
own token/idle/attempt budgets. A transport deadline interrupts the attempt and
lets durable delivery retry; it is not an early Action failure terminal.
