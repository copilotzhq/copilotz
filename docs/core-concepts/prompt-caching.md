# Prompt caching

Copilotz relies on provider-native implicit prompt caching. Persisted message
history is append-only: within one memory epoch, each agent request must begin
with the exact provider-ready prefix used by the previous turn and then append
only newly persisted messages.

## Deterministic prompt layout

The provider transcript is built in this order:

1. stable agent, thread, memory, skill, and tool context;
2. persisted graph messages in creation order;
3. final same-role coalescing required by providers that require alternating
   user and assistant roles.

Each persisted human user message ends with
`<message_timestamp>ISO-8601</message_timestamp>` in LLM history, derived from
that message's immutable `createdAt`. Assistant, peer-agent, tool, system, and
internal job messages are not tagged. Invalid legacy dates are omitted. Database
and UI content are unchanged, and model-imitated timestamp tags are filtered
from generated output.

Tool results are never moved beside earlier calls. Input trimming may treat a
completed tool cycle as one atomic unit, but it preserves graph order. A
long-term-memory rollover intentionally replaces the old prefix and starts a new
cache epoch.

Expected cache resets occur when long-term-memory rollover or input trimming
removes old history; when agent instructions, thread context, skills, tool
definitions, or their ordering change; when the model or transport changes; and
when the provider expires or evicts its cache. Ordinary turns and durable
recovery only append messages and do not intentionally reset the prefix.

## Provider behavior

Provider defaults are used everywhere. Copilotz does not expose cache modes,
TTLs, breakpoints, retention, or provider cache-resource management.

OpenAI requests additionally receive a runtime-only `prompt_cache_key`. It is
the SHA-256 of the namespace, thread ID, and agent ID and is identical for API
key and ChatGPT transports. It is never persisted in LLM configuration, and
requests never contain `prompt_cache_options`, `prompt_cache_retention`, or
explicit breakpoint markers.

## Recovery

Reusable partial output is committed before continuation:

1. an assistant message stores sanitized text, reasoning, and canonical
   structured output with `skipRouting`;
2. an internal job message stores `<recovery_cue>` and routes back to the same
   agent;
3. the normal message router creates the next LLM attempt.

Internal cues are part of model history but are filtered from chat hydration.
Visible assistant fragments share a recovery chain ID and exact join separator,
so chat UI renders them as one answer. Raw malformed provider output remains in
`llm_attempt` diagnostics, not message history. Attempts with no reusable output
persist nothing and try the next fallback with the unchanged transcript.

## Metrics and release gate

Every provider attempt retains input/output totals, cache-read input tokens,
cache-creation/write input tokens, cost, status, and recovery linkage. Run
`scripts/cache-smoke.ts` against both API-key and ChatGPT transports before
publishing. Turns two and three must report non-zero, increasing cache reads; an
early-prefix mutation is the negative control. A zero-cache warm turn blocks
publication until the serialized prefix is inspected.
