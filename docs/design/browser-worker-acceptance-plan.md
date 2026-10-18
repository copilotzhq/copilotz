# Finish the owner refactor through a browser-worker acceptance project

Updated: 18 October 2026, 13:45 UTC.

## Finish line and scope

Complete the owner-based Copilotz refactor, then migrate Compass, including its
frontend, onto that foundation. A small project is the first end-to-end proof,
not a substitute for completing the approved refactor backlog.

The agreed first project has **two real agents, built-in and custom tools, a
local server owner, and all authored Actions/Processors/agent work in the
browser**. It consumes ordinary public package exports from a pinned draft
dependency cohort. No internal owner-host imports, injected test-only transport
factory, server execution fallback, or ordinary Action masquerading as an agent.

No merge, package publication, production deployment or production database
migration is authorized by this plan.

## Execution boundary

- Browser worker: both agents, agent delegation, model orchestration, authored
  Actions and Processors, browser-compatible built-in tools, custom tools, and
  frontend rendering
- Local owner: trusted authorization, schema and transaction enforcement,
  durable events/operations, content catalog/storage, subscriptions and work
  dispatch
- Collection commands from browser code travel through the owner connection; the
  browser never opens the owner's database
- View data selection remains owner-authorized; UI rendering runs in the browser
- When no browser worker is available, browser-assigned work remains pending or
  follows its explicit interruption policy. The server must not silently run it
- Browser credentials/CORS are explicit constraints. The first built-in tools
  are `get_current_time` and `wait`; custom source lookup uses a same-origin
  fixture endpoint. Terminal/filesystem tools are not claimed to run natively in
  a browser. Provider secrets must not enter browser bundles

## Small application

Use two agents, Researcher and Writer, over one shared plugin definition:

1. User submits a research request in the browser
2. Researcher uses built-in `get_current_time` and a custom source-lookup tool
3. Researcher delegates to Writer through the real agent/child execution path
4. Writer invokes a custom tool backed by a durable Action to save a document
5. A custom Processor reacts to the committed change and updates a task/status
6. The browser renders the document and task through subscribed public Views
7. Both agent output and completed content can be read again after reload

Use a deterministic model provider for repeatable CI, preserving the real Core
agent, tool, content and execution pipeline. Add one real-provider smoke test
through an approved credential path before claiming complete application proof.

Suggested project layout (separate from the library test harness):

- `shared/`: agents, tools, Actions, Processors, Collections and Views
- `owner/`: server entry, local persistence and trusted admission policy
- `web/`: UI entry and dedicated browser worker entry
- `tests/`: external process/browser acceptance tests
- `deno.json` / frontend package manifest: exact draft dependency cohort
- `README.md`: clean-checkout run, reset, test and failure-reproduction commands

The intended DX remains one `createCopilotz`: storage configuration selects the
owner; an owner connection selects a worker. The worker package entry must share
that implementation while keeping database/server modules out of its artifact.

## Ordered delivery milestones

### M0. Freeze the contract and bootstrap the consumer

- Preserve the current content safety work as an explicitly unaccepted draft
- Record exact Copilotz/Oxian/Ominipg commits and artifact/import mappings
- Scaffold the separate project and browser test runner
- Exercise the public owner and browser-worker construction path first
- Report unsupported public APIs as failing consumer scenarios, not workarounds

Exit: a clean checkout starts the local owner, loads the browser and connects a
real browser worker over WebSocket through the intended public API. Runtime
records demonstrate owner execution; the old embedded branch cannot satisfy it.

### M1. Complete the genuine two-agent execution path

- Enable ordinary Core composition, preparation/deferred resolution and child
  work
- Complete successful stream close/seal, retain/follow and content readback;
  abort-only streams do not satisfy real agent execution
- Connect built-in/custom tools and custom Processor execution in the browser
- Route all persistent mutations and reads through the owner

Exit: the full Researcher → Writer → document → Processor workflow completes,
with durable results and accepted output. Browser/server traces establish where
work executed. A server-side authored-work fallback deliberately fails the test.

### M2. Complete public frontend data and observation APIs

- Adapt the existing generic server/client contract to owner application
  services
- Provide authorized list/detail Views and live subscriptions
- Implement reconnect/checkpoint repair and preserve local unsaved drafts
- Verify scope filtering before pagination or content disclosure

Exit: two authorized browser observers see the committed document/task update
without tool-name refresh counters or manual refresh. Reload/reconnect preserves
history and does not duplicate mutations. An unauthorized scope sees no data.

### M3. Finish owner recovery and lifecycle parity

- Retry the same submission after a lost reply; verify one durable mutation
- Disconnect/terminate a browser worker during tool/Processor/stream work
- Restart the owner and restore completed history and supported interrupted work
- Distinguish observer detach, explicit Stop and worker disappearance
- Prove cancellation, pending work, retry, continuation and physical cleanup
- Test a second browser worker taking eligible work without reviving the old
  attempt

Exit: each failure has a documented expected result, persisted evidence and an
external test. Unknown outcomes stay explicit. No test adopts a tentative stream
suffix or assumes exactly-once execution of an arbitrary external side effect.

### M4. Finish the complete refactor and retire replaced paths

- Map every unchecked item in `implementation-status.md` to an implementation
  and acceptance test; uncovered approved scope remains open
- Complete remaining query/vector/protected-value/content/provider contracts,
  public placement/default composition and supported recovery semantics
- Make normal embedded/default construction use the same completed owner model;
  no external PostgreSQL service becomes a prerequisite
- Remove replaced composition branches, wrappers and lease-era responsibility
  once all their still-supported callers are migrated
- Pass package reachability and browser/worker role boundaries without weakening
  allowlists or exporting private implementations just to satisfy the checker
- Run coherent backend, full regression, failure/load and resource-bound gates

Exit: the small project passes and the complete refactor checklist is
reconciled. The demo alone cannot mark unrelated open requirements complete. Any
scope change needs an explicit decision rather than an implicit deferral.

### M5. Migrate Compass and refactor its frontend

- Use the actual current Compass source and preserve its existing feature set
- Start with a real chat → agent/tool → document → live UI vertical
- Migrate its remaining agents, workspace resources, jobs and integrations
- Replace callback-driven frontend refreshes with authorized live Views where
  appropriate; preserve navigation, drafts, auth and tenant isolation
- Rehearse schema/cutover behavior on disposable data before production approval

Exit: the migrated Compass UI passes its own feature and recovery acceptance
matrix against the new architecture. Final review includes reproducible
commands, exact dependency versions, migration/operations documentation and
explicit merge/publication/deployment approval.

## Minimum external acceptance matrix

| ID  | Scenario               | Required observable result                                  |
| --- | ---------------------- | ----------------------------------------------------------- |
| A01 | Clean start            | No external DB prerequisite; owner and browser worker ready |
| A02 | Browser-only execution | Real agents/tools/Actions/Processors execute in browser     |
| A03 | Two-agent flow         | Delegation completes and persists one document/task result  |
| A04 | Built-in/custom tools  | Both real tool paths execute through ordinary Core          |
| A05 | DB ownership           | No DB driver/storage capability in browser artifact         |
| A06 | Completed content      | Ordered accepted output, terminal state and readback        |
| A07 | Live Views             | Two browser observers update from committed state           |
| A08 | Idempotent retry       | Lost submit reply does not duplicate the durable mutation   |
| A09 | Worker loss            | No stale completion or silent server execution fallback     |
| A10 | Reconnect/restart      | History and supported recovery survive process boundaries   |
| A11 | Stop/detach            | Detach does not impersonate cancellation; Stop propagates   |
| A12 | Scope isolation        | Unauthorized Views, body reads and mutations refuse         |
| A13 | Actual drain           | Shutdown joins real raw calls and physical cleanup          |
| A14 | Resource/load bounds   | Recorded SQL, latency and memory; bounded admission/drain   |
| A15 | Compass parity         | Real migrated application/frontend acceptance matrix passes |

Internal regressions remain valuable supporting evidence. New implementation
work should be tied to one of these consumer scenarios or an explicit item of
the complete approved refactor backlog.

## Known checkpoint limits

The current content draft has passing scoped coordinator, driver and actual-host
diagnostics; its consolidated dual-backend acceptance remains open. Real-time
cold opening of 21 writers with one-second protection exposed insufficient
margin. Controlled construction followed by real-time held-cleanup tests isolate
cleanup fairness; they do not establish cold-burst capacity. Preserve both
results and establish the supported configuration/load envelope.
