# Owner identity evidence, directory commands and flow Processors

## Existing contracts

`authorization/evaluator.ts:61` exposes declared Collection reads but no trusted
identity evidence. `authorization/credentials.ts:169` accepts only owner-checked
Action effects. `authorization/directory-read.ts:107` resolves declarations on
the owner and audits reads. `engine/context.ts:426` joins Action transactions to
the current schema writer. `engine/commands.ts:263` fences every writer with an
epoch-row update. `authorization/flow.ts:118` admits internal effects only for
consumed/admitted Actions. `actions/protected-action-source.ts:31` resolves
ancestry from retained operation/delivery indexes, never caller metadata.

## Identity verification

Composition registers `authorization.identityVerifiers[alias]` with revision,
allowed Action aliases and an owner-only `verify` function. Actions call
`context.authentication.verify(alias, input)` outside their database
transaction. The callback receives a detached request, owner-selected
flow/proof/operation binding, an abort signal and an opaque stable exchange key.
It verifies issuer, signature/keys, audience, expiry, nonce/PKCE and provider
subject, or exchanges a code itself. Provider secrets and key caches live only
in this trusted owner callback, never in worker resources. An arbitrary
`externalEffect` outcome is not evidence. The verifier returns bounded typed
`{ issuer, subject, principal,
claims? }` identity facts; raw tokens/codes must
not be returned.

Policy declares `evidence: [alias]` and reads `evidence.get(alias)` from its
owner-local transaction. The reader accepts no receipt ID, claims or binding
from callers. It selects only that verifier's receipt for the exact current
schema, namespace, tenant, flow, accepted root operation and client proof.
Source policy explicitly grants `identityVerifiers: [alias]` before
verification. Only consumed flow Actions or their admitted descendants may
request verification. Missing evidence returns null; undeclared reads and
mismatched bindings refuse. Policy chooses exact session claims from evidence
and fresh owner records.

Reserve a receipt durably before external I/O; perform no network operation
inside the serialized writer. Store only an input digest and bindings in the
reservation. Completed evidence is persisted before returning and replay reads
that same receipt without invoking the provider again. Changed input/revision
cannot reuse an exchange. Concurrent or crash-interrupted pending exchanges fail
closed; they are never automatically reissued. This unavoidable ambiguity
between a provider's one-use exchange and our durable commit requires a new
login flow after an interrupted exchange, not a claim of distributed
exactly-once I/O. A rolled-back source login transaction does not erase verified
evidence.

Evidence expires with the flow. An owner-only pruning API removes expired
private evidence, including abandoned reservations; payload-free audit receipts
remain under existing owner receipt retention. Expired/deleted flow state cannot
be replayed into another exchange. No sensitive request is written to receipts,
events or audit rows. Workers can request verification, not install callbacks or
write evidence. Policy inputs and verifier outputs are detached and bounded.

## Directory commands: explicit trusted owner service, atomic SQL

Choose a declared trusted directory service command over an asynchronous outbox:
login needs a result before selecting the account, and route/account/membership
and session effects must commit together. Composition registers a fixed schema,
namespace, command name, revision, allowed Actions, destination policy and
owner-local command implementation.
`context.directory.command(alias, input,
{ operationKey })` works standalone or
in `context.transaction` through `tx.directory.command`. Remote transactions
stage the same bounded command.

This is an explicit trusted identity-service boundary using the platform's
existing SQL owner command model, not a worker-selected SQL endpoint or captured
application handle. The implementation receives only the joined SQL executor,
fixed destination scope, detached input, evidence reader, command time and
signal. It owns its directory repository and migrations. It must not call
captured application APIs, perform network I/O or commit independently. Native
Collection storage must still be written through its repository invariants;
service-owned identity tables are the recommended representation. This avoids
pretending a Collection's single-record reducer is a multi-owner transaction.

The source policy grants the exact command alias; the destination authorization
callback independently checks source authority, input and evidence before any
implementation executes. The destination writer must already be attached in the
same process and database. Lock its epoch row inside the source transaction and
resolve that exact holder/epoch to the live local owner, serializing with
ordinary destination commands and fencing takeover. No implicit provisioning or
owner acquisition inside the source transaction. Opposing multi-owner lock
orders may be refused/rolled back by the database; no side effects may occur
outside that transaction.

Directory commands join the existing Collection plan in call order, so a
membership command reads the account written immediately before it.
Transactional commands return void; derive stable account IDs from verified
evidence before planning. Standalone commands can return results but commit
independently. The source transaction contains directory writes, source account
writes, credential effects and both audit receipts. Any failure rolls all of
them back. A key bound to source scope, root/run, declaration revision and
invocation key provides idempotency; changed input conflicts. Replay still
checks both policies. Public audit intent stores coordinates and input/output
digests only, not payload or credentials. Private command receipts retain
bounded results for replay. Callback handles are revoked on return. Commands
cannot dynamically select a schema, namespace, SQL text, function or destination
alias. New physical tenant schemas are provisioned by trusted host orchestration
before activation; route publication alone must not claim an unprovisioned
tenant is active.

## Flow Processors

Keep one native flow guard. Carry owner-created event and delivery coordinates
in the private invocation binding. A Processor may exercise Collection effects
only if its live leased delivery names that Processor, the triggering immutable
event is indexed in the flow's exact consumed operation, and the retained flow
and proof are current. This includes a detached delivery of such an event; an
arbitrary ancestry chain or metadata claim is insufficient. Product policy must
also return `flowProcessors: [processorId]` and the exact Collection grants.
Fresh output validation belongs in that policy, as for every mutation.

Processors cannot mint sessions/flows, request identity evidence, invoke
directory service commands or start separate operations. Child Actions do not
inherit Action-descendant rights from a Processor. A later event outside the
consumed operation cannot continue this delegation. Existing invocation lease,
owner epoch, cancellation, flow expiry and mutation-result checks still apply.
Owner RPC dispatch also installs the retained context invocation; this closes a
gap where a remote Processor operation start could lack ambient authority. No
generic system principal or implicit host trust is introduced.

## Verification and migration

Use real owner transactions on both backends and a separate worker transport.
Prove verified login and exact session grants; worker-forged facts, other flow,
proof and tenant refusal; no second exchange on replay or pending crash state.
Prove directory provisioning/publication, source/destination denial, stable
replay and source/destination rollback. Prove granted and denied Processor
projection, outside-operation refusal, forbidden detached start and credential
minting. Run check, fmt, lint delta and type guard, then full suites on PGlite
and Postgres 55434. Update authorization documentation with a generic OIDC-style
example and explicit product changes: replace Action-side provider checkpoints
and captured directory writes; grant only the reviewed projector's bounded
Collection effects.

## Validation outcome

The six local/real-worker security matrices pass on both backends. Full Postgres
passes 2,572 tests and 126 steps. PGlite covers all 568 files with 2,425 tests
and 104 steps passing: its required 60-minute full command timed out, and the
interrupted file plus remaining files passed in a continuation. The browser
bundle regression exposed missing pure annotations on the two lazy context
stores; corrected and verified before the final attempts. No server or device
implementation files were changed.
