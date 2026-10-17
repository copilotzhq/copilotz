# Processor Action identity across retries

## Defect and regression

A repeated pipeline test exposed two executions of the same explicitly keyed
Tool call. The first Processor attempt created a message before dispatching its
Tools, consuming an Action ordinal. On retry, the persisted plan skipped message
creation. The Tool's explicit operation key was unchanged, but its generated
Action run ID changed from ordinal 2 to ordinal 1. Both terminal Events were
real; weakening terminal provenance validation would hide duplicate execution.

The Processor context now supplies a stable root prefix for explicitly keyed
calls. The Action invoker passes the normalized explicit key to the internal
host-prefix callback and appends that key once. The Processor scope and Action
ID are encoded separately in the named prefix. Different Actions and deliveries
remain isolated. Unnamed calls retain ordinal identities; named calls no longer
consume unnamed ordinals. Prepared and nested invocation logic is unchanged, and
existing one-argument host callbacks remain supported.

The retained context regression verifies repeated and reordered named calls,
trim normalization, separate delivery and Action identities, and unnamed calls
interleaved with named calls. It fails against the previous source. The original
seven-case parallel pipeline integration file is also rerun without relaxing its
assertions, including the unavailable-root failure case.

## Compatibility and rollout boundary

This changes durable IDs for explicitly keyed calls in the legacy Processor
context, and the numbering of unnamed calls mixed with named calls. Existing
pre-fix IDs are not automatically translated. Do not upgrade an in-flight legacy
workflow and assume its old receipts will deduplicate the new IDs. Production
cutover needs a separately reviewed drain/versioning or migration plan. This
draft change does not migrate stored data or authorize deployment.

The new owner-mediated registered invocation path already separates explicit
keys from unnamed ordinals. This correction addresses the retained legacy
execution path used by the pipeline tests. It does not establish general
recovery parity or resolve separate Tool cursor-replay concerns.
