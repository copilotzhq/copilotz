# Core recipient routing and native snapshot cleanup

Status: implemented and verified on `fc02889d`; Oxian 0.23.1.

## Current behavior

- `plugins/core/actions/create-thread-message/index.ts:301` preserves explicit
  recipients, including an empty list. Only omitted recipients default to thread
  agents (`:145`). This distinction must remain.
- `plugins/core/processors/message-input/index.ts:255` resolves a real
  participant before an Agent resource alias, retaining human/tool/job types.
  This is correct.
- `plugins/core/processors/message-router/index.ts:294` loops over all explicit
  routed recipients and starts `callLlm.prepare`. The subsequent snapshot
  resolves an Agent only for agent participants (`:318`), but non-agent
  recipients reach the Agent-only rejection at `:574`. Legitimate human delivery
  is consequently treated as failed Agent work.
- The incoming `plugins/core/views/chat/recipients.ts` preserves mentioned
  participant IDs and handles configured Agent aliases separately. It needs
  regression coverage, not a human-recipient suppression workaround.
- `plugins/channel-core/processors/egress/index.ts:130` independently consumes
  public `message.created` events and delivers Agent output to external
  bindings. Local human coordination can remain a recorded message without
  inference.
- `runtime/collections/kernel.ts:4537` uses ordinary database snapshots on
  pooled backends. For an exclusive backend with policies, it closes that
  snapshot and performs the read inside an owner command (`:4553`) to avoid
  nested transactions.
- `runtime/execution/owner-capabilities.ts:841` retains the snapshot's private
  cleanup promise. Close waits for the callback and cleanup proof (`:900`), and
  refuses unknown cleanup (`:915`). This fail-closed guarantee must remain.

## Target and public API

No new public API. Explicit recipients remain unchanged in stored messages and
event envelopes. Only current Agent recipients start LLM preparation. Human-only
messages settle successfully without provider calls; mixed messages retain every
recipient and start turns only for agents. Existing membership, current
authority, Agent-removal, and scoped-turn checks remain enforced.

Reproduce first-chat snapshot closure with native invocation authority and a
real policy on both backends. Trace the original error and exact cleanup
observation through admission, the exclusive owner-command fallback, and owner
resource close. Correct the faulty lifetime/cleanup boundary once established;
never substitute success for unknown physical cleanup or suppress delivery
failures.

## Deletions and constraints

Replace incorrect unconditional recipient-to-Agent routing in place. No feature
flags, alternate factories, continuation overrides, or new polling. Preserve
channel egress behavior. Avoid additional owner round trips per recipient where
the current snapshot already supplies the required participant information.

Keep changes in Core and the proven snapshot boundary. Coordinate any necessary
engine or authorization changes rather than altering unrelated owner lifecycle.

## Guarantees and validation

1. Real human-only, agent-only, and mixed recipient messages: retained
   recipients, exact provider-call counts, successful background settlement, no
   dead letters.
2. Cover both direct message creation and message input; preserve composer
   mention resolution and omitted-versus-explicit recipient semantics.
3. Native first chat with policies: complete reply and confirmed snapshot
   cleanup on PGlite and PostgreSQL. Verify subsequent snapshot admission still
   works.
4. Retain negative coverage for cancellation, unknown cleanup, scope closure,
   and authority changes. Do not weaken cleanup or settlement assertions.
5. Targeted tests on both backends, then the full suite once per backend with
   the 3600-second wrapper. PostgreSQL uses port 55436 and both test URL
   variables.
6. Run gates, formatting, and lint comparison; document actual counts and
   failures.

## Risks

Private backend identity must follow wrapper functions and recoverable
generations without tagging a shared prototype method. PostgreSQL's mixed-write
snapshot tests must continue to prove pooled isolation. Existing custom-provider
snapshots keep their native capability and cleanup checks. No changes to engine
or authorization implementations are required.

## Established snapshot cause and implementation

The unchanged product first-chat test reproduces on this worktree. Temporary
owner diagnostics reveal that Ominipg 0.10.1 rejects the vector-enabled PGlite
constructor configuration before invoking the snapshot callback. Its native
exclusive-snapshot certification accepts only relaxedDurability and startParams;
the generated extensions map is refused. With no opened callback, the owner has
no cleanup control and surfaces owner_cleanup_unknown. The small policy fixture
without vector support passes, confirming the missing reproduction condition.

Known managed PGlite sessions will enter the existing serialized owner-command
snapshot directly, using only compiled Collection reads. Private capability
identity records preserve this backend fact through SQL adapters, attachment
wrappers, and recoverable generation selection. This introduces no public API,
backend probe, per-command round trip, or exception-string fallback. PostgreSQL
continues using its native repeatable snapshot and separate current-policy lane.
Unknown/custom capabilities retain their existing native admission path.

Regression fixtures must enable the vector extension. Owner cleanup remains
fail-closed; no unknown outcome is converted to success. Temporary diagnostics
will be removed. The user completed the prerequisite merge; no Git mutation is
needed or authorized in this session.

The automatic owner-backed path is limited to package-selected native PGlite
without custom constructor configuration or background sync. Explicit custom
providers/configuration retain native admission, including its refusal for
unsupported hooks. `runtime/persistence/ominipg.test.ts` verifies this with a
real custom-configured connection; default vector-enabled native chat remains
green.
