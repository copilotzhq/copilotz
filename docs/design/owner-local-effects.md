# Private fresh local Action effects

Reviewed on 17 October 2026. This activates effect capabilities for the existing
private fresh owner-local Action placement. Public placement selection, retained
local history and Processor effects remain separate gates.

## One protocol and policy

Local Actions use the same begun/confirmed/not-started receipt protocol,
invocation-bound client, declared Action reconciliation hook and owner handlers
as workers. No local effect table, protocol, timer or retry loop was added.

The existing `OwnerHostPolicy.effectOutcome` and `effectNotStarted` callbacks
receive the existing `OwnerExecutionAssignment` union. Its `placement` tag
separates real local assignments from workers; a local call never invents a
worker identity. No duplicate local effect policy bundle is required.

The owner resolves current input/ctx authority for begin and narrow settlement
authority for confirm, verified not-started and state inspection. The
[current-authority prerequisite](owner-effect-authority.md) applies to both:
current grants after awaits, exact captured lifecycle data, and private lifetime
checks through reply exposure. Ordinary ctx revocation refuses a new step or
Collection write while permitting already-started work's authorized settlement.
A caught rejected ctx call still fails the invocation under the existing shared
kernel; that does not revoke otherwise valid narrow settlement.

## Bound local port and lifetime

`createOwnerLocalActionPort` exposes only the four fixed effect routes. It
checks kind, domain, logical key and exact namespace/run before owner
submission, copies inputs before suspension and validates reply/reference/status
with the shared effect decoder. Malformed or uncertain replies quarantine the
attempt.

Every effect call uses the existing local raw-call tracker, admission bound and
drain. A held begin shares capacity with other ctx calls. No proceed is exposed
before known COMMIT acknowledgement and current lifetime. Sealing forbids new
begin calls; terminal submission forbids starting further effect calls. Narrow
owner settlement does not reopen author-facing calls after the driver closes its
context. Raw work remains charged until its actual promise settles.

Unknown committed and aborted outcomes remain unknown to the caller. Neither can
be relabeled rollback, retried automatically or used to release terminal
capacity. A committed begun receipt may remain when a late reply is suppressed.
A committed confirmation may remain after its acknowledgement is lost, without
another send.

## Same-attempt reconciliation

A fresh begin yields one proceed. A repeated begun step requires the Action's
declared reconciliation hook; without one, the shared indeterminate latch cannot
be erased by catching the failure. A hook may return a confirmed outcome or
verified no-start evidence. The owner still validates current authority and the
registered outcome/evidence policy. Later begin calls read current durable state
and never receive another first-send permission for that logical step.

These tests exercise a live same-attempt hook, not restart adoption or
permission to revive a retired local handle. General retained-local-history
recovery remains unsupported by this checkpoint.

## Independent acceptance

| Gate                                                | Cases | Result |
| --------------------------------------------------- | ----: | ------ |
| Canonical connected inventory, 17 files             |   192 | Passed |
| Shared effect / execution / local Action core       |    77 | Passed |
| Effect client, inventory and recovery compatibility |    31 | Passed |
| Pure local port and registered-local driver         |    71 | Passed |
| Role bundles                                        |    12 | Passed |

The PostgreSQL gates total 300 cases and use ordinary typechecking, as do the
pure and bundle runs. All pass without skips. The full local-host file has 71
cases, including 36 new effect cases over in-process and WebSocket transports:

- Confirmed and not-started replay, no resend, and ctx-revoked settlement
- Unknown begin/confirm/not-started outcomes, each committed and aborted
- Denied outcome/evidence policy with begun evidence preserved
- Policy returning true after revoking settlement, without a stale receipt
- Actual committed-begin reply held through release or host close, retaining raw
  occupancy and withholding proceed
- Irreversible unresolved repeated begin and declared same-attempt
  reconciliation

The held transaction-reply fixtures block the owner command pump after DB
COMMIT. Their independent raw-SQL observations do not claim concurrently
admitted owner commands or caller-facing scan behavior.

All 319 unique disposable databases were dropped, with no remaining sessions and
the PostgreSQL service stopped. All 1,599 source hashes and seven tested paths
matched the frozen candidate, with unchanged sibling manifests. Lint, formatting
and six architecture checks pass; the strict surface remains 46 exports, 16
external imports and 725 reachable production modules.

Initial positive fixtures incorrectly repeated an unresolved begin without a
reconcile hook and correctly hit the existing indeterminate latch. Positive
cases were corrected; separate refusal cases preserve that guarantee.
Zero-selected filter/setup runs are not acceptance evidence. This checkpoint is
scoped parity, not a new full-suite release, package publication or production
migration.
