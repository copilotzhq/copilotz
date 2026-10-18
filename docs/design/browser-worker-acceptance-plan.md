# Finish the owner refactor through a browser-worker acceptance project

Updated: 18 October 2026, 14:47 UTC.

## Finish line and scope

Complete the owner-based Copilotz refactor, then migrate Compass, including its
frontend, onto that foundation. A small project is the first end-to-end proof,
not a substitute for completing the approved refactor backlog.

The agreed first project is **Node.js-based**, with **two real agents, built-in
and custom tools, a local Node.js server owner, and all authored Actions,
Processors and agent work in the browser**. Its UI is implemented **exclusively
through Views**. That full-stack frontend capability belongs to the current
Copilotz refactor, not a separate hand-written UI application.

The project consumes ordinary public package exports from a pinned draft cohort.
No internal owner-host imports, injected test-only transport factory, server
execution fallback, or ordinary Action masquerading as an agent.

No merge, package publication, production deployment or production database
migration is authorized by this plan.

## Execution boundary

- Browser worker: both agents, agent delegation, model orchestration, authored
  Actions and Processors, browser-compatible built-in tools, custom tools, and
  frontend rendering
- Local Node.js owner: trusted authorization, schema and transaction
  enforcement, durable events/operations, content catalog/storage, subscriptions
  and work dispatch
- Collection commands from browser code travel through the owner connection; the
  browser never opens the owner's database
- View data selection remains owner-authorized; UI rendering runs in the
  browser. Screens, layout, navigation, forms, interactions, state and reactive
  updates are expressed through Views and framework-provided bindings. A
  separate hand-written UI application with a few embedded Views does not
  satisfy this goal
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

Required project structure follows Copilotz primitives at the project root:

- `actions/`: custom durable business Actions
- `adapters/`: provider and integration adapters
- `collections/`: task/document definitions
- `processors/`: committed-event processing
- `views/`: **all** authored frontend UI, layout and interaction
- `resources/`: both agent definitions, tool resources and configuration
- Root `application.ts` and `worker.ts`: minimal Node owner/browser-worker
  bootstraps
- Root `copilotz.json`, `package.json` and Node-compatible build configuration
- `tests/`: external process/browser acceptance tests
- `README.md`: clean-checkout run/reset/test commands and draft dependency
  cohort

Do not replace this with a `shared/`, `owner/`, `web/` application architecture.
The framework may generate its browser shell and mounting code, but authored UI
belongs to Views. A rendering adapter may use React internally; that does not
make a standalone React application an acceptable substitute for View
primitives. The acceptance project's server/tooling must run on Node.js without
requiring a Deno runtime installation. Deno-based library tests alone are not
Node evidence.

The intended DX remains one `createCopilotz`: storage configuration selects the
owner; an owner connection selects a worker. The worker package entry must share
that implementation while keeping database/server modules out of its artifact.

## Full-stack implementation contract

These choices complete the approved live Views contract. They do not replace
owner-backed execution or authorize a parallel frontend runtime.

- Bootstrap mounts one root navigation View. All authored layouts, screens,
  forms, loading/error states and child composition remain in `views/`.
  `ctx.show` resolves children through the existing plugin registry; route data
  belongs to an ordinary Resource. Generated code only loads composition,
  connects the public client, installs renderer/navigation adapters and mounts.
- Preserve the pure one-shot text renderer. Add a separate live renderer session
  with typed composition-derived Collections, Actions and resources. Renderer
  output is not inert projected data and must not pass through the data snapshot
  serializer. Projection and current viewer authorization remain mandatory.
- Live Collection selections use owner-backed initial snapshot plus committed
  change replay, reset and authorization semantics. Existing operation-selection
  observation is not a general Collection subscription. Do not connect Views to
  the legacy application/database facade to make the example work.
- The renderer tracks read dependencies and owns nested identity, subscriptions,
  invalidation and disposal. Sharing is bounded and requires identical selection
  and authorization identities. Scope changes clear protected cached values
  before a new identity renders; late results cannot repopulate old state.
- View event handlers invoke typed Actions through existing public receipt,
  idempotency and observation contracts. Render evaluation cannot submit
  Actions. Retries reuse one logical submission identity. Navigation/unmount
  detaches local waits; only explicit Stop requests durable cancellation.
- Local form drafts and navigation state belong to mounted renderer state. Use
  session-local drafts by default for the acceptance project. This does not
  introduce another primitive or an authoritative application-level data store.
- The Node consumer must install, build and start without a Deno executable.
  Complete npm-compatible dependency/export resolution, Node-native build/role
  output and a Node HTTP/WebSocket host adapter. Running a Deno-produced bundle
  under Node is supporting evidence, not that consumer acceptance gate.

Before the separate project begins, library tests must cover initial/replayed
selections, revoked scopes, nested disposal, stale results, form submission
retries, explicit cancellation versus detach, routing and Back/Forward, and
server-free browser artifacts. The later real-browser acceptance repeats those
behaviors across process and browser boundaries.

## Ordered delivery milestones

**Required order: finish the current complete owner refactor → run the new
browser project as its end-to-end acceptance gate → migrate Compass/frontend.**
The acceptance contract can be prepared now. Building a new application must not
replace the unfinished implementation or reduce the approved backlog.

### M0. Finish the current owner-based implementation

Complete every remaining approved library workstream, retaining the detailed
items in `implementation-status.md`:

- Content: finish current lifetime safety, successful close/seal, retain/follow,
  accepted-prefix readback, current copies, promotion and retained references
- Recovery: retained history/takeover, replay of already-admitted stages,
  continuation/parked execution, durable handoff, cancellation and settlement
- Data/authority: remaining read/query/vector/snapshot/subscription integration,
  protected values/credential slots, cross-owner and remaining wire contracts
- Public composition: one supported `createCopilotz` construction model,
  ordinary embedded defaults without an external DB, owner-only serving,
  connected plugin workers and complete placement parity
- Core/providers: real model/message routing, deferred preparation/agent work,
  content-aware providers, channel rendering/egress and remaining conversions
- Full-stack Views/clients: public HTTP/read/observation contracts, authorized
  live data, frontend rendering/composition, navigation and interaction
  bindings, browser state/subscriptions and removal of legacy-engine coupling
  from client APIs. The complete application UI must be implementable
  exclusively as Views
- Node.js delivery: ordinary Node owner startup, npm-compatible package/build
  surfaces and actual Node execution evidence for the validated dependency
  cohort

Finish the actual library functionality before moving into the new project. Do
not leave the default factory on the old engine and call the refactor done.

Exit: each remaining requirement has implementation and scoped evidence, or is
still explicitly open. Any proposed scope change requires a decision; absence
from the small demo does not justify deferral.

### M1. Consolidate, retire and validate the completed refactor

- Migrate all still-supported library/plugin callers and remove replaced
  composition branches, wrappers, option types and lease-era responsibility
- Reconcile every unchecked item across all seven checklist workstreams
- Pass public package reachability and browser/worker role boundaries without
  weakening allowlists or exporting private implementations solely for the guard
- Complete backend, recovery/failure, full regression and resource-bound gates
- Establish the supported protection/capacity envelope, preserving prior
  overload evidence rather than hiding it through test timing changes
- Record the exact draft dependency cohort and migration/operational docs

Exit: current refactor implementation and library validation are complete,
**pending the separate end-to-end acceptance gate below**. No merge or
publication.

### M2. Build the separate two-agent browser acceptance project

- Consume public package artifacts from the exact validated draft cohort
- Start a local Node.js owner and connect a real dedicated browser worker over
  WS
- Keep Actions, adapters, Collections, Processors, Views and resources at root
- Author the entire frontend through Views, using only framework-generated
  shell/bootstrap code
- Run both agents, built-in/custom tools, Actions and Processors in the browser
- Implement the full Researcher → Writer → document → Processor → live View flow
- Use real Core and content behavior; no private imports, injected internal
  factories, fake browser execution or server business-work fallback
- Add clean-checkout run/reset/test commands and browser/server traces

Exit: one actual browser workflow completes through the intended public API with
owner-owned persistence and truthful streamed/completed content.

### M3. Run the outside-in acceptance gate

- Exercise every applicable A01–A14 scenario below in real browser/processes
- Test two observers, lost replies, reconnect, worker termination, owner
  restart, explicit Stop, retained history, live Views and scope/credential
  isolation
- Keep the deterministic provider for repeatability and add an approved real
  provider smoke test without browser-bundled long-lived secrets
- Any newly exposed implementation gap returns to M0/M1 before acceptance

Exit: another developer can reproduce the end-to-end checks from a clean
checkout. Passing internal tests alone is insufficient.

### M4. Migrate Compass and refactor its frontend

- Use the actual current Compass source and preserve its existing feature set
- Start with a real chat → agent/tool → document → live UI vertical
- Migrate remaining agents, workspace resources, jobs and integrations
- Implement the migrated frontend through Views, including screens and
  interaction; replace callback-driven refreshes with authorized live state
  while preserving navigation, drafts, auth and tenant isolation
- Rehearse schema/cutover behavior on disposable data before production approval

Exit: the migrated Compass UI passes its own feature/recovery acceptance matrix
against the completed owner architecture (A15).

### M5. Final review and explicitly approved release

Present exact dependency versions, reproducible commands, test/failure evidence,
retirement diff, migration requirements and rollback/operational guidance.
Obtain explicit approval before dependency merges/publication, Compass
deployment or production database changes. Existing release pipelines must
remain untriggered until that approval.

## Minimum external acceptance matrix

| ID  | Scenario               | Required observable result                                                         |
| --- | ---------------------- | ---------------------------------------------------------------------------------- |
| A01 | Clean start            | Node.js server/tooling; no Deno or external DB prerequisite; owner/browser ready   |
| A02 | Browser-only execution | Real agents/tools/Actions/Processors execute in browser                            |
| A03 | Two-agent flow         | Delegation completes and persists one document/task result                         |
| A04 | Built-in/custom tools  | Both real tool paths execute through ordinary Core                                 |
| A05 | DB ownership           | No DB driver/storage capability in browser artifact                                |
| A06 | Completed content      | Ordered accepted output, terminal state and readback                               |
| A07 | Live Views             | Entire UI is authored via Views; two browser observers update from committed state |
| A08 | Idempotent retry       | Lost submit reply does not duplicate the durable mutation                          |
| A09 | Worker loss            | No stale completion or silent server execution fallback                            |
| A10 | Reconnect/restart      | History and supported recovery survive process boundaries                          |
| A11 | Stop/detach            | Detach does not impersonate cancellation; Stop propagates                          |
| A12 | Scope isolation        | Unauthorized Views, body reads and mutations refuse                                |
| A13 | Actual drain           | Shutdown joins real raw calls and physical cleanup                                 |
| A14 | Resource/load bounds   | Recorded SQL, latency and memory; bounded admission/drain                          |
| A15 | Compass parity         | Full Compass frontend uses Views and its feature/recovery acceptance matrix passes |

Internal regressions remain valuable supporting evidence. Implementation work
first completes the current approved refactor backlog. These consumer scenarios
provide the subsequent end-to-end acceptance criteria.

## Known checkpoint limits

The current content draft has passing scoped coordinator, driver and actual-host
diagnostics; its consolidated dual-backend acceptance remains open. Real-time
cold opening of 21 writers with one-second protection exposed insufficient
margin. Controlled construction followed by real-time held-cleanup tests isolate
cleanup fairness; they do not establish cold-burst capacity. Preserve both
results and establish the supported configuration/load envelope.
