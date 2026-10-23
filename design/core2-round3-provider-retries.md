# Provider completion reuse and retryable failures

Status: implemented; full verification in progress.

## Current behavior

- `plugins/llm/actions/call-llm/index.ts:2820` restores candidate effects;
  `:3069` confirms every received failure and replays it on all deliveries.
  `:3181` replaces a failed primary with a missing-credential error when the
  remaining candidates are skipped.
- `runtime/actions/invoker.ts:880` checks unfinished effects correctly, but
  `:912` settles every ordinary error immediately. The delivery's retry budget
  is not currently passed by `runtime/engine/context.ts:542`.
- `runtime/events/store.ts:1656` already provides bounded exponential retry
  scheduling. `plugins/llm/adapters/bridge/http.ts:113` retains HTTP status but
  drops Retry-After.
  `plugins/core/processors/project-agent-failure/index.ts:118` uses the same
  generic text for every terminal failure.

## Target and design

Keep the existing external-effect state machine and owner fencing. A known
incomplete transient attempt closes its effect with a retry receipt, not a
reusable failure. The next delivery selects a fresh deterministic attempt step.
Only completed results and permanent failures are replayed. A candidate scan
finds any completed fallback before retrying an earlier transient candidate, so
post-completion failures never cause another paid request. An uncertain dispatch
without a retained completion remains indeterminate; do not invent no-start
proof or weaken recovery for other external effects.

Classify transport/TLS/reset, timeout, HTTP 429 and 5xx failures through adapter
cause chains. Preserve bounded Retry-After metadata without retaining response
headers or credentials. Authentication, billing, invalid requests, and semantic
refusals remain permanent. A missing-credential skip never replaces a real
provider error. Prefer a retryable provider error over fallback configuration
failure.

Pass the retained delivery attempt budget through the private Engine context
into the Action invoker. Preserve explicit retryability and the bounded delay
through the data-only owner capability error codec. Explicit `retryable: true`
errors defer terminal Action events while attempts remain; implicit ordinary
errors keep current behavior. Use the existing owner scheduler for capped
exponential backoff and bounded Retry-After. Emit the failure timeline entry
only from a terminal Action event, with a safe reason and the exhausted attempt
count. Direct Action hosts without a delivery budget retain immediate
settlement.

Full-suite discovery exposed serial recipient routing: a transient failure
prevented the next recipient from starting, while the old immediate terminal
silently advanced to the next recipient. Route independent Agent recipients with
serial input preparation (one owned snapshot at a time), concurrent provider
execution, and all settlements awaited before failing the delivery. Stable
per-recipient Action keys replay completed peers on retry. The existing
subscription-session overlap assertion remains unchanged; a native two-Agent
regression proves that only the failed peer calls its provider again.

## Public API and deletions

No new public configuration or provider selection path. The existing explicit
retryability error marker receives its intended lifecycle behavior in delivery
execution. Retry delay is a bounded scalar error hint. Replace unconditional
failure replay and the unconditional end-of-plan credential error. No file
removals or changes to generic effect reconciliation.

## Guarantees and tests

- Native agent delivery with a simulated network/TLS failure then success: two
  provider calls, one reply, no early failed event, on both PGlite and
  PostgreSQL.
- Permanent auth failure: one call, immediate terminal event; missing fallback
  credentials preserve the primary cause.
- Retryable errors exhaust the retained delivery budget with one terminal event
  and actionable failure text. Retry-After supports seconds and HTTP dates.
- Completed response and completed fallback remain reusable after later faults;
  no new provider call. Existing deadline/stream tests retain their guarantees.
- Targeted suites on both backends, then each full suite once using the 3600s
  watchdog; PostgreSQL port 55436. Gates and changed-file lint/format checks.

## Risks

No received completion is not proof of zero provider billing: a provider can
process a request before a connection breaks. Retry only the explicitly
classified incomplete attempts requested here; retain indeterminate handling for
worker loss or unknown dispatch outcomes. Native transport errors retain their
safe classification, not raw request/credential data. The final delivery budget
is owner-supplied, never caller metadata. Backoff must not occupy worker slots.
