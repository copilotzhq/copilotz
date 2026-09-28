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
