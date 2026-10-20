# Fail-closed authorization for 0.89.0

## Current state

- `runtime/application/host.ts:306` promises narrower caller authority, but
  `runtime/actions/invoker.ts:798`, `runtime/execution/workload.ts:312`, and
  `server/facade.ts:304` call user code without ambient invocation bindings.
- `runtime/authorization/invocation.ts:253` binds Action context proxies only.
  Execution bindings resolve retained ingress lazily, so ambient host admission
  also needs the owner-resolved authority (never caller metadata).
- `runtime/authorization/evaluator.ts:466` captures policy JSON without checking
  Collection filters. `collection-constraints.ts:69` matches that unchecked
  data.
- `runtime/collections/kernel.ts:1052,1334,1362,3776` skips missing
  registrations.
- `runtime/authorization/owner.ts:458` checks exposed resources but reports no
  alias; core-http's custom routes do not declare their Collection dependencies.

## Target and public API

Execute Action/resume, Processor/error callbacks, and HTTP handlers/input
mappers under revocable ambient authority. Resolve retained execution ingress in
the owner context; retain all existing command-time liveness and policy checks.
Host startup/scripts remain trusted. Existing invocation bindings remain
private. Capture host Event, Collection and standalone-operation provenance
before queuing so trusted work retains its origin. Uncatalogued retained Events
stay unclassified: they can execute but gain no Collection access.

Validate Collection filter objects at decision capture, including mutation and
command filters. Reuse the bounded predicate compiler for nested predicates.
Unknown keys and malformed values yield the generic typed forbidden error.

Refuse missing registrations whenever an invocation is not trusted host.
Preserve owner-internal reads and explicitly trusted policy lookup. Cover reads,
ordinary writes, transactional writes, and graph endpoints.

HTTP adapters may declare required Collection aliases. core-http declares every
Collection its routes read; Server checks these and exposed aliases at startup,
with errors naming missing bindings. Make facade authentication and returned
scope authority required in public types. Explicitly export channel ingress
event.

## Deletions and documentation

Remove obsolete dangling comments, optional authentication typing, and docs that
recommend avoiding ambient app calls. Correct the two adapter/resource READMEs
and add the three fixes to the release changelog. No compatibility paths or
flags.

## Validation

Regression tests cover denied/allowed ambient Action and route mutations, nested
ambient Actions, Processor execution, trusted host access, unbound reads/writes,
startup missing bindings, malformed filters (including nested and mutation
filters), and valid filters. Run targeted tests, check, fmt, lint delta against
249, full type guard, then full PGlite and Postgres (port 55435, both variables)
with the shared 3600-second runner. Isolate failures and compare main as needed.

## Risks

Ambient binding must retain invocation lifetime and immediate Action identity,
including resumed work and error handlers. Retained ingress is resolved once per
execution context; authorization remains fresh inside commands. Stricter
required types require honest fixture updates. Owner-alarm fixtures need
explicit system placement and policy bindings; unclassified execution never
becomes host simply because a binding is absent. Streaming callbacks must not
retain authority past handler completion.
