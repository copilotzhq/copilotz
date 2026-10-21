# Worker authority, flow descendants and directory reads

Round 4 extends these contracts with owner-verified identity evidence, atomic
directory service commands and bounded Processor projections. See
[the Round 4 design](sec2-owner-identity-directory-processors.md) for the
current extensions and validation results.

## Current state

- `runtime/execution/owner-capability-worker.ts:616` calls every worker user
  handler without the ambient invocation used by embedded execution.
- `runtime/authorization/invocation.ts:248` enters only contexts bound by the
  owner. `runtime/application/host.ts:337` treats an absent binding as host
  trust.
- `runtime/execution/owner-capabilities.ts:1078` already resolves opaque context
  handles and rejects worker-selected owner scope before executing capabilities.
- `runtime/authorization/flow.ts:42` permits only the named continuation and
  restricts internal effects to its consumed run. Product policy runs afterwards
  (`runtime/authorization/evaluator.ts:317`).
- `runtime/actions/authorized-capture.ts:212` evaluates an owner-created frame
  with its source operation; its parent run is available but not passed onward.
- `runtime/authorization/directory.ts:23` exposes staff-only policy reads, not
  Action directory delegation.

## Target and implementation

Every worker entrypoint (Action execute/resume/reconcile, Processor
handle/error, prepare factory) enters a revocable ambient binding. That binding
carries an opaque reverse capability, never serialized trusted-host authority.
Captured application Action and Collection methods in the same owner scope
dispatch through that capability, using the exact context held by the owner.
Foreign scopes and unsupported host ingress fail closed. Independent host
bootstrap remains trusted. The binding lasts through awaits and is closed when
user execution ends. Owner policy, provenance, cancellation and scope remain
resolved at the existing RPC boundary. No additional per-command transport hop
is introduced.

Flow child capture supplies the owner's parent run and exact current operation.
The guard accepts a child only if its parent is the consumed continuation or an
already admitted descendant in that same accepted operation. Store that
induction proof in an ordinary owner receipt in the capture transaction; policy
refusal rolls it back. Subsequent authorization and internal effects check that
receipt. The credential's direct admission surface remains the named
continuation only. Receipt identity binds tenant, namespace, flow, root,
operation, Action and run; replay never creates another child effect. No schema
changes are necessary.

## Public API

Worker and flow changes add no public surface. Policy continues receiving
`intent.invocation`; child capture additionally includes owner-resolved parent
provenance. Existing exact Action and Collection grants remain mandatory.

Directory reads are implemented as a same-database capability. Composition uses
`defineDatabaseDirectoryRead` (exported from the engine entrypoint), registered
as `authorization.directoryReads[alias]`. It fixes schema, namespace,
Collection, revision, allowed Action aliases, top-level projection, maximum
bytes and a mandatory destination authorization callback. Public Action code
calls `context.directory.get(alias, id)`. The caller policy grants exact
requests through `directoryReads` constraints and receives the executing
invocation. Processors, trusted-host execution without caller authority,
undeclared Actions and arbitrary worker paths do not receive this privilege.

The tenant owner resolves the declaration, checks current authority and
invocation, evaluates source policy, reads fresh directory state through the
same transaction, requires destination policy approval, projects and bounds the
result, rechecks source policy/liveness and commits an audit receipt before
disclosure. Destination policy sees detached values, not a transaction. The
receipt records principal, tenant/namespace, operation, run/parent, declaration
and destination, field list, ID/result digests and command time. It contains no
credentials or record payload. Refusals roll back; audit failure prevents
disclosure. Every call is fresh.

This deliberately excludes remote databases, listing, writes, provisioning and
cross-owner transactions. No independent owner RPC, new schema or distributed
transaction protocol is introduced. A future remote implementation must
authenticate both owners, bind an opaque short-lived capability to source and
destination, recheck before disclosure and audit at both ends without holding
the tenant writer across network I/O. Staff policy reads are not reused.

## Deletions and risks

Replace the unbound handler call and exact-run-only flow branches in place. Move
the owner command capture helper from `invocation.ts` to
`invocation-command.ts`; shared ambient storage imports no owner execution code.
Worker-role graph audit admits the reviewed ambient/JSON modules and only the
fixed native async-context loader. Dynamic loading in plugin modules stays
refused. No feature flags, alternate runtimes, schema or server ingress changes.
Host and context option shapes differ; forwarding must explicitly translate only
supported replay options and reject scope widening. Worker fixtures must run in
a real subprocess so ambient storage cannot accidentally leak from the gateway.
Receipt retention must follow the operation's existing logical receipt
lifecycle.

## Verification

Run worker refusal/allow matrix across awaits, context controls, foreign scopes,
Processor and prepare entrypoints, and independent host calls. Run native flow
transitive child writes, denied child policy, direct child refusal,
outside-operation refusal and exact replay. Run targeted tests on both engines,
static checks, fmt, lint delta and type guard, then one full suite per backend
with the lane timeout.

## Round 3: detached starts and owner-authorized credential claims

The alias merge exposed a misleading regression assertion, not host authority:
`runtime/actions/resume.ts` treats a settled Action refusal as completed
delivery. A real `child` alias produced a failed Action terminal with
`code: forbidden`, no invocation capture and no child execution, while its
operation completed. `runtime/actions/protected-action-source.ts` retains the
originating flow across operation ancestry. Refuse new operations earlier:
`engine.ts` checks the owner-held ingress for standalone starts;
`continuation-work.ts` checks the retained invocation for linked starts.
Same-operation child Actions remain the only delegation surface. Tests assert
authorization reasons and absence of admission/effects, rather than delivery
status.

Detached Processor deliveries retain ingress authority and cannot become flow
Action descendants. Scheduled/alarm occurrences instead use independently
configured `systemScopes` and collection policy (`collections/alarms.ts`,
`collections/alarm-authority.ts`). A flow may write a schedule only with its
explicit mutation grant; subsequent work requires the scheduler's independent
policy grant. Scheduling never inherits implicit host trust.

Choose Option B for credentials: enforce owner-selected claims for both local
and remote execution at the existing credential commit boundary. Option A would
remove remote login but leave boolean minting grants broad for local Actions.
Replace `sessions.create: true` with `{ principal, maxAge }`: exact principal
and maximum lifetime. Replace flow kind arrays with a map from kind to
`{ continuation, maxAge }`: exact composition alias and maximum lifetime. No
wildcards or boolean compatibility path. Scope, credential ID, signing key and
flow principal remain owner-generated or owner-retained. Revocation retains its
existing self/tenant checks. Transactions, replay identity and cookie projection
continue through the existing credential implementation.

Policy must select these claims from trusted owner data or independently
validated authentication evidence; reflecting requested claims is not
verification. Remote workers can propose credentials, never authorize their
claims. Owner checks run in the transaction before session/effect insertion;
refusal rolls back all staged writes and projects no cookie. Regressions
exercise principal, lifetime and continuation substitution over the real worker
transport and a legitimate login with the recommended explicit grant.
