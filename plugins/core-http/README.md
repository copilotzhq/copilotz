# Core HTTP

Optional generated conversation HTTP integration. Compose `coreHttpPlugin` with
Server and configure authentication and exposure using the Server Resource. Core
alone installs no HTTP routes.

Conversation sends resolve all selected participants before writing, then enroll
them inside the existing `createThreadMessage` Action transaction. Selected
membership and the message commit together. Direct `addThreadParticipant` calls
remain available; conversation sends no longer produce a child enrollment Action
for each selected agent and instead record one bulk membership command.

When upgrading, drain old in-flight sends before switching workers, or
explicitly migrate their recorded progress during scheduled downtime. A
partially completed old send must not restart its per-member work as a new bulk
operation.

Message reads project the rows already admitted by the owner's list, get, named
query, or subscription policy. They never issue an internal `history` query. The
shared tool-output projection removes unreadable content and execution metadata
before Server resolves any retained references. Server uses the same namespace,
retained authority, declared content fields, and content resolver as the
original collection read. No trusted policy scope is required: projection can
only remove rows or fields from the authorized result, and resolution loads only
references that survive that projection. An explicitly requested named query
still requires the owner's permission.

Snapshots and batches each resolve content once, in their original order, with
one shared byte budget. The window's field selection, body limit, exclusions,
and deferral options remain intact. Feed message events use a thread-scoped list
through the same helper, and discard duplicate body envelopes. History discovery
retains its separate source-invocation checks for private status candidates;
ordinary reads already have the owner's authorization for those rows.
