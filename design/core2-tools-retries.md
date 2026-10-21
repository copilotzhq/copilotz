# Trusted tool origin and durable LLM retries

## Current behavior

- `plugins/core/shared/workflow-metadata.ts:865` validates the entire metadata
  map as a Tool origin. Policy additions therefore invalidate valid cursors. The
  same parser is used by the terminal projector
  (`processors/project-tool-result/terminal.ts:32`).
- `plugins/core/shared/tool-plan.ts:650` dispatches named durable Actions and
  treats settled Action failures as results. Owner policy refusal needs the same
  terminal treatment; arbitrary infrastructure failures must remain retryable.
- `runtime/actions/protected-context.ts:32` resolves the exact owner-retained
  source body, independently of caller metadata. Tool plans retain the original
  LLM Action, thread and agent and validate stage ownership before projection.
- `plugins/llm/actions/call-llm/index.ts:2895` dispatches the provider without
  an effect checkpoint. Stream finalization, capture and accounting happen after
  the provider completes (`:2948`). A lost delivery can therefore repeat
  billing.
- `runtime/execution/owner-capture.ts:119` captures prepared bytes through
  incarnation-scoped streams. `runtime/content/database-repository.ts:1995` also
  captures content locally. Both paths must preserve prepared bytes.
- `runtime/execution/executor.ts:464` and
  `runtime/execution/owner-capability-worker.ts:594` omit explicit deadlines.
- `runtime/application/worker.ts:92` leaves the worker host-call timeout unset.
  Published Oxian 0.23.0 `src/worker/session.ts:216` defaults it to 30 seconds;
  `src/work/host-call-channel.ts:598` clamps explicit deadlines to that budget.
  Both the worker factory and owner host budget must allow LLM finalization.
- `plugins/core/shared/chat-feed.ts:179` treats a failed physical content lane
  as terminal reply failure, even before the logical operation settles.

## Target and API

Keep strict validation of the Core-owned origin fields, extracting those fields
from the surrounding metadata map. Do not copy unrelated app keys into cursors.
Add one async `trustedCoreToolOrigin(context)` accessor for app Actions.
Validate the cursor against owner-retained source data and the durable plan;
caller metadata alone is never authority. Apps derive Space from that trusted
thread using their existing scoped collection policy. Document that the
synchronous metadata parser validates shape only.

Use the existing invocation-bound `context.effect` protocol around each provider
candidate. Confirm the normalized provider response before post-completion
content work. Replays finalize the checkpointed response without provider I/O.
Unconfirmed dispatch remains indeterminate, never blindly redispatched. Preserve
fallback and usage accounting. Checkpoint content in a JSON-safe representation.

Fix any byte loss in prepared-content capture and verify matching digest/length
before promotion. A retry may use a new stream incarnation but must capture the
same complete text. Empty text-only final answers fail visibly.

Reuse Core's bounded mutation retry policy for atomic thread-message writes.
Refresh membership and recipient reads after known optimistic/serialization
rollback so concurrent Tool/Ask activity cannot settle a message as failed.
Policy/schema refusals and indeterminate commits remain failures.

Give delivery and nested host work an explicit bounded LLM-compatible deadline.
Classify host deadline interruption as retryable infrastructure loss. Only
durable Action/operation terminals may fail the feed; physical stream errors
retain provisional content while the operation retries.

## Deletions and guarantees

Remove whole-map Tool parser rejection and early stream-failure settlement.
Replace uncheckpointed provider dispatch; do not add alternate execution modes.
Preserve strict nested schemas, tool stage authorization, content digest checks,
effect ambiguity handling, cancellation and durable idempotency.

## Validation

Regressions cover app metadata, forged origin, refused tool settlement, prepared
capture retry with full bytes, completion checkpoint followed by delivery loss
with one provider dispatch, and feed failure only on terminal settlement. Run
targeted suites on PGlite and Postgres 55436; then full suites with the required
timeout wrapper, package gates and lint comparison.

## Risks

Provider completion without a confirmed checkpoint cannot safely be retried;
surface the existing indeterminate-effect failure. Large response checkpoints
must preserve binary content without credentials. Deadline changes affect all
delivery work because an app Action can call an LLM at any nesting depth. Avoid
engine lifecycle, authorization directory and server/subscription changes.
