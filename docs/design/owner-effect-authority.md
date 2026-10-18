# Current effect authority and terminal cleanup

This is a private owner-runtime checkpoint, independently validated on 17
October 2026. It is the prerequisite for local effect parity, not completion of
that parity or public placement activation.

## Counterexamples and required guarantees

An effect's outcome or no-start policy may await and revoke its grant. A
worker's final input-policy call can also revoke ctx permission after execution
authority was initially sampled. Neither may release first-send permission or
accept stale settlement. A valid rewrite of a captured lifecycle body plus its
digest must not silently substitute input or metadata after authorization.

Private lifetime can end during inventory, receipt, projection or COMMIT work.
Loss observed by an in-transaction fence refuses the command and rolls back its
writes. Loss after the last transactional check, including while COMMIT is
underway, may still leave a committed receipt. The caller-facing fence
suppresses the reply; it cannot undo that receipt or turn an uncertain send into
permission to retry.

Ctx permission and narrow settlement permission remain distinct. Already-started
current work may settle after ordinary ctx revocation. Old assignments, sessions
or attempts cannot use that exception.

## Reuse and simplification

- Capture effect configuration callbacks once; later caller mutation cannot
  replace or disable the private witness
- Expand the existing effect authorization WeakMap with exact caller, command
  and time, rather than add another registry or authority table
- Recheck SQL authorization after policy/inventory awaits; use the existing
  boundary's synchronous private fence for all four effect routes and Collection
  commands, including duplicate/result and known-COMMIT acknowledgement paths
- Generalize the existing local execution recheck to both placements. Detach the
  resolver result, then compare the durable attempt and bounded captured
  lifecycle data, check mode-appropriate cancellation/grants, and finish with
  the host's exact private witness. Do not recursively rerun input policy
- Reuse schema guarantees instead of adding redundant event-header rereads.
  Semantic event UPDATE is rejected by the existing trigger; deletion cascades
  away its delivery. Exact delivery presence/equality covers changed source
  pointers and scopes. Mutable lifecycle bodies still require explicit equality
- Keep the existing effect client, receipt protocol and uncertainty handling. No
  new lease, timer, storage table, retry loop or local effect implementation is
  introduced by this prerequisite

The low-level SQL protocol seam permits fixtures without a private runtime
witness. The actual owner host always supplies that witness and wires the
boundary fence. A false, throwing, asynchronous or reentrantly invalidated
private check cannot restore authority.

## Terminal abandoned obligations

The broader gate exposed a separate defect after lease-era fixture repair:
normal delivery settlement passed its live-attempt-scoped store into abandoned
nested-Action recovery after the delivery had become terminal. That store
correctly rejected the recovery append.

The terminal settlement callback now creates a private owner-control view using
its actual transaction, base owner epoch/holder/clock and shared catalog hooks.
The existing recovery writer verifies the terminal delivery and exact open
obligation. Ordinary lifecycle and Collection writes retain the live attempt
restriction. Publication still follows the existing outer-COMMIT path. The view
is not exposed to workers and does not authorize arbitrary replay or takeover.

## Validation and preserved failures

Final frozen-candidate PostgreSQL validation uses ordinary typechecking:

| Gate                                            | Cases | Result |
| ----------------------------------------------- | ----: | ------ |
| Canonical worker/local integration, 17 files    |   156 | Passed |
| Effects, execution and local Action core        |    77 | Passed |
| Child/preparation/effect recovery compatibility |    73 | Passed |
| Lost-delivery direct fixture consumer           |     7 | Passed |

All 334 final disposable databases were dropped, with no remaining sessions and
the PostgreSQL service stopped. All 1,598 source hashes and the 12 tested paths
matched; sibling Oxian/Ominipg hashes were unchanged. Lint, formatting and six
architecture checks pass; the strict surface remains 46 exports, 16 external
imports and 725 reachable production modules.

These 313 scoped cases are not a new full-suite release claim. They include both
transports, mixed placement, held replies, unknown outcomes, close/drain
behavior, ctx-revoked settlement, exact late private checks and valid
captured-body/digest replacement. The late local-body-read regression exercises
the actual execution layer; it is not a claim of a separately isolated full-host
local Collection private-revocation scenario.

Preserved development evidence includes:

- The two original effect-policy revocation failures, followed by passing fixes
- The actual-host final input-policy bug on both transports: stale begin
  proceeded before the fix, then both regressions passed
- Related compatibility initially passed 61 and failed 12. The exact preceding
  accepted baseline reproduced those same 12 fixture failures (3 passed)
- Contract/barrier fixtures now explicitly seed an ended predecessor using a
  private owner-control transaction, exact NULL-deadline transition and atomic
  old-assignment revocation. Attempts, budget, due time and effect evidence stay
  unchanged; replacement and the next genuine claim remain separate. This setup
  deliberately includes ineligible histories to test refusal. It is not proof of
  production recovery eligibility or remote quiescence
- The abandoned seed's missing appender schema was corrected before exposing the
  genuine production terminal-writer mismatch; that regression then passed
- Earlier typecheck/setup/assertion failures remain distinct from final results;
  none was hidden with no-check, skipped assertions or weakened effect barriers

Remaining work includes local effect port/host parity, F9 quiet-writer
protection, general retained-history recovery and the coherent full release
gate. No merge, package publication or production migration is implied.
