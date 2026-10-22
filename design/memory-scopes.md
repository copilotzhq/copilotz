# Memory scopes (0.90.0)

Reuse immutable `memoryNote` records and `memorySpace` containers. Canonical IDs
are `memory-space:personal:<participantId>`, `memory-space:space:<spaceId>` and
`memory-space:thread:<threadId>`. Access follows the verified human initiator,
current Core space membership and current thread, never peer-thread grants.
Consolidation remains thread continuity; immediate `remember` appends notes and
`retire_memory` permanently retires them. Corrections append a replacement.

Expose scope predicates through public policy helpers using existing collection
constraints. Applications retain control of authorization; caller-supplied scope
IDs never establish authority. No human initiator means no personal scope.

A separate personal context contribution renders at most 20 items in stable ID
order, bounded in size, immediately before the newest message. It is omitted
unless the initiator is the only human thread participant. Explicit tools can
access that initiator's personal scope in shared threads.

Remove Core's automatic `USER METADATA` dump entirely. Hosts may explicitly
select allowed user facts in a context contributor, with initiator authorization
and shared-thread privacy checks, placed before the newest message. Agent
`workingMemory`, `expertise` and `learnedPreferences` remain configuration, not
a fourth memory scope; render only these fields deterministically at the same
tail position. Neither human metadata nor mutable agent configuration enters the
system prompt.

Lazily import legacy participant memory with deterministic per-item IDs and
idempotent creates; retain the original metadata for recovery. Reads, prompt
preparation and the profile must trigger import. The profile uses personal notes
and retirement. Remove `update_user_memory` in 0.90.0 with an explicit upgrade
note: apps must install Memory and expose `remember` (`scope: "personal"`). This
avoids a second plugin dependency and a misleading compatibility write path.

Verify parallel appends, scope isolation and movement, initiator propagation,
legacy import and prompt placement/stability with targeted backend tests.
