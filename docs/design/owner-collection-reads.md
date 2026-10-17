# Ordinary Collection reads in registered execution

This private owner-host increment connects existing scoped `get`, `list` and
`aggregate` methods to registered Actions and Processors, in worker and fresh
owner-local placement. It does not activate a new public topology/facade API.
All current changes remain draft: no merge or package publication.

## One execution path

- The placement-neutral invocation kernels share a small bound read capability
- Workers use the existing owner `project` reverse call; local ports use their
  existing raw-call tracker and exact attempt witness
- One fixed `collections.read` projection reuses the existing Collection SQL
  query/aggregate evaluators, including predicates, typed ordering and cursors
- No new transport workload, read receipt, read cache, authorization map,
  persistent table, timer or execution lease is introduced
- The owner supplies the schema and namespace. Caller data supplies only a real
  Collection alias, operation and closed query data

A plain read observes committed state at its statement(s). Successive reads can
see later writes. They do not constitute a snapshot, and reads are not exposed
by the transaction planning context. F5's separate bounded, read-only REPEATABLE
READ session remains a distinct implementation gate.

## Explicit whole-record policy

The internal host policy adds optional `collectionRead`. Omission or an
undefined result denies. An empty filter is an explicit whole-record grant. The
callback receives the current SQL executor, captured assignment facts, detached
request and owner command time. Facts preserve Action/Processor and placement
identity and original invocation coordinates, including the local Processor
ordinal where applicable. They do not expose captured ctx or settlement grant
flags as if those were current permissions.

```ts
collectionRead(tx, binding, request, time) {
  // Perform current application authorization using tx and the original facts.
  // Authorize the requested operation, including aggregate fields/metrics.
  return { filter: { field: "visibility", eq: "public" } };
}
```

A policy grants the whole ordinary record or requested aggregate, not
field-level redaction. Its detached filter is appended conjunctively to caller
conditions before cursor lookup, LIMIT and aggregation. Get uses the same
constrained list compiler with exact id and limit one. Caller `all` cannot
replace policy scope.

Current ctx and original input/prepared-source authorization are required before
disclosure. The policy is evaluated again after the query, and the complete
normalized filter must remain equal. A final live check follows the last awaited
policy, then the existing boundary and placement lifetime fences apply. Scope
changes refuse; they do not trigger post-filtering or a silent rerun.

The related Processor correction rechecks current phase grants, exact durable
facts and source body after awaited policies. Local body comparison follows the
last grant callback. Settlement remains independently authorized and does not
require ctx/input policy. Unrelated grant changes do not change attempt
identity.

## Supported subset and bounds

- Registered ordinary object Collections only; declared secret/content and
  reserved protocol Collections refuse
- `get({id})`, `list(query)` and `aggregate(query)`; optional signal and
  unresolved `content: false` only
- No relation/include hydration, text/vector search, executable named `queries`,
  content loading, snapshots or subscriptions
- Closed, detached JSON input: at most 64 KiB, depth 32 and 20,000 nodes;
  bounded identifiers, 64 conjunctive filters and at most 1,000 requested
  rows/groups
- SQL transfer protection: at most 256 KiB per projected row and 1 MiB of JSON
  payload per SQL result. Cursor lookups have their own bound. Marker/transport
  overhead is additional and bounded by row count; this is not a total wire-byte
  promise. Final returned JSON is separately bounded to 1 MiB
- Legacy `where.namespace`, `where.createdAt` and `where.updatedAt` have
  different list/aggregate interpretations, so this boundary refuses them. Use
  the shared structured `filter` syntax for those physical columns. Existing
  unbounded legacy query semantics are not silently changed

The existing aggregate scalar equality compiler now binds numbers/booleans as
text, matching list equality on PGlite as well as PostgreSQL. This is a shared
compiler correction, covered by a causal regression.

## Protected source handling

Get/list pages and cursor anchors carry a fixed protected-source check through
the same bounded SQL result. An unsafe anchor refuses before its order value can
influence returned records. No separate cursor preflight is added.

Aggregation checks every source row admitted by the complete query and policy
scope, independently of metric FILTER. Unsafe rows remain present for a global
rejection flag, but their data is replaced with NULL before metric/bucket
expressions can put protected values into SQL error messages. The flag
propagates across all groups before LIMIT; it cannot be hidden by aliases or a
truncated page. Unsafe payloads are suppressed before driver transfer and the
whole read refuses. Empty aggregates retain count-zero behavior.

The source check shares reserved-key and protected-family constants with the
ordinary-value guard. Its strict JSONPath check also conservatively refuses a
protected family inside a schema-valued object; it does not claim exact parity
with the JS guard's depth/node/finite-number limits. The output still passes
that JS guard. This is a protocol/transfer boundary, not a bound on SQL scans,
server memory, CPU or elapsed query time. PostgreSQL may evaluate a fixed source
check more than once when flattening a query.

## Cancellation and acknowledgement

A timeout or abort does not establish that SQL stopped. Local ports retain raw
occupancy until the real call drains. Tests hold the acknowledgement after
actual COMMIT: the owner pump is held, close cannot certify quiescence early,
and a revoked result is suppressed. Independent SQL observations in those tests
are not described as concurrent owner commands. Reads generate no events or
command receipts; the existing owner transaction fence still operates.

## Validation

Independent PostgreSQL-configured gates pass 43 SQL/read compatibility cases and
53 complete worker/local Processor cases. The complete 17-file canonical gate
passes 252 cases on the final packaging snapshot, including all 32 new actual
host read scenarios and built Action/Processor get/list/aggregate on both
transports. The 222-case invocation/port/driver gate also passes.

The first canonical/role runs retained 250/2 and 9/3 pass/fail results: the
build allowlist had not yet admitted the three new pure read modules. A
four-file packaging/fixture correction admits only those modules, asserts that
all five owner SQL/source modules remain absent, and exercises real reads from
the built artifacts. The complete final canonical 252 and role 12 runs pass with
ordinary typechecking and no skips. The original 29 implementation/test paths
remain byte-identical to their independently tested snapshot. This is explicitly
correction evidence across two frozen snapshots, not an invented single run.

Changed-file lint/format and all six architecture/package checks pass: 46
exports, 16 external imports and 730 reachable production modules. Root's
focused 113-case run uses native PGlite where required and has one explicitly
skipped PostgreSQL ordering case; the independent PostgreSQL gate covers that
case. The initial reviewer-only database adapter rejected six legacy `:memory:`
fixtures; its explicit sentinel translation was corrected and the complete 43
case gate rerun without changing repository source. Earlier typecheck/fixture
failures and causal red tests remain recorded alongside their corrections.

Tests cover policy-time grant/body changes, independent ctx/settlement grants,
forged declarations, alias/namespace/row scope, protected aggregate/cursor
sources, SQL error disclosure, bounded raw payloads, microsecond/null/tie
cursors and actual close/raw-drain behavior. These are scoped checks, not a new
full-suite acceptance. Published dependency pins and public/history gates are
unchanged.
