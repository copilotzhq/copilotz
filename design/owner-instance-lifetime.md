# Database instance ownership and sequential shutdown

## Evidence and reproduced path

The following locations refer to the pre-fix `feat/next` commit `66d5463a`.

- `runtime/engine/commands.ts:762` indexes live entries only by durable holder
  UUID. `openDatabaseOwner` reuses a same-epoch holder across SQL session
  objects.
- `commands.ts:828` separately indexes repository bindings by session object. A
  raw database and `createSqlSession(database)` therefore miss each other's
  bindings; lazy helper acquisition increments the shared owner's attachment
  count without a corresponding runtime release.
- `runtime/persistence/lifecycle.ts:862,874` creates fresh session wrappers for
  injected/shared persistence. `runtime/events/session.ts:204` carries no
  database identity through those wrappers.
- `runtime/vectors/index.ts:107` provisions through an owner command. Calling it
  on the raw database while a provisioning gateway owns a wrapper can reproduce
  the extra attachment using supported APIs.
- Round-one final release drains work only when the reference count reaches
  zero. It cannot fix an owner kept alive by an unintended helper attachment.

## Design

Bind every SQL adapter and managed transaction to its underlying database object
identity. Runtime owners are scoped by that identity and schema; durable holder
and epoch remain fencing evidence, not a process-wide database identity.
Multiple wrappers of one database must share the owner and repository binding. A
different instance must acquire its own holder, even when durable coordinates
match.

Retain explicit reference counting for runtime attachments. Repository helpers
borrow an existing binding without acquiring another attachment. A
helper-created owner starts with zero runtime attachments; the first runtime
then owns its lifetime. Serialize owner opening within each database/schema so
concurrent wrappers cannot create duplicate owners. Preserve captured repository
authority: old repositories never retarget a new owner. Directory joins must
resolve the destination owner only in the source transaction's database
instance, while retaining durable fencing checks. Managed transaction aliases
retain that identity alongside their existing commit and rollback gates.

Preserve round-one command/publication/alarm draining and synchronous authority
revocation on forced stop. Do not add polling, sleeps, retries, per-command SQL,
public cache controls, or a parallel runtime path. Add no public API.

## Proof and validation

First reproduce with the unchanged owner implementation: a provisioning gateway,
raw-database provisioning helper, serving runtime, listener shutdown, directory
cleanup, runtime close, private schema drop, database close, then a new database
instance on the same persistent database/schema. Use file-backed PGlite and a
`plat_*` PostgreSQL database on port 55433. Record holder/epoch and
closed-database transaction attempts; retain strong diagnostic references so GC
cannot mask reuse.

Test wrapper sharing, independent-instance fencing, concurrent opening, shared
attachment release, captured stale repositories, and exact sequential teardown.
Keep every round-one drain regression. Run targeted tests, then full suites with
the prescribed one-hour wrapper, then check/format/lint delta/type guard.

## Risks and exclusions

Identity propagation must cover nested SQL adapters and transaction facades used
by directory joins. Arbitrary user wrappers remain separate identities unless
created through the supported adapter. Reconnectable persistence must preserve
its existing generation fencing and recovery behavior. No authorization policy,
server transport or device-client redesign is included. The local Oxian link is
development-only and must not be committed.

## Reproduction result

The unchanged `feat/next` implementation fails the native sequential fixture on
both file-backed PGlite and PostgreSQL with the exact Ominipg 0.10.1
`assertOpen` → `transaction` → `session.ts:210,74,219` → `commands.ts:325,417`
stack. The raw vector provisioning helper creates the unmatched attachment while
the gateway is alive. The serving runtime then reuses that owner's adapter. A
closes fully, but its owner remains registered; B's startup catalog command is
sent through A's closed adapter. No sleep or forced GC is involved.

The regression retains the database instances and records closed owner states,
holder IDs and epochs. Additional tests cover concurrent adapters, exact
explicit attachment counts, stale repository refusal, identical durable
coordinates in distinct instances, directory-join isolation, and PostgreSQL
takeover fencing.
