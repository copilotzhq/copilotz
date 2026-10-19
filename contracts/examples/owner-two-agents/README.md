# Two agents, one owner

A separate Node 24 project using public Copilotz primitives. The local Node
process is the single durable owner. A real dedicated browser Worker runs all
Actions, Processors, tools and model-adapter calls. The only application UI is
an actual React View selected through the public View resolver and fed by the
canonical, authorized live Collection API.

This is an acceptance application, not a new runtime or a React renderer shipped
by the library. The application supplies its small React host. The two agents
use the real Core agent harness and `ask` continuation. Only model inference is
replaced by a deterministic request-driven adapter. There is no real provider
integration, model account, API key or model billing in this project.

## Project layout

- `actions/`: save a draft, read it, review it and publish it
- `adapters/llm/scripted/`: deterministic model responses, with no process
  counter
- `collections/`: owner-persisted plans and bounded execution-evidence records
- `processors/record-evidence/`: browser execution that records durable facts
- `views/dashboard/`: the complete React application View
- `resources/`: two Agent definitions, their least-privilege tool grants and the
  model connection
- `composition.ts`: ordinary static primitive/plugin composition
- `owner.ts`, `server.ts`: Node owner, policy, ingress and loopback listeners
- `worker.ts`: the portable public worker role, with no database options
- `browser.ts`, `view-host.ts`: browser lifecycle, live selections and React
  mount

The built-in `get_current_time` tool is the actual public built-in resource. The
custom plan tools mutate owner-backed Collections through the common worker
capability path. This demo does not claim browser support for a terminal or an
operating-system computer tool.

## Prerequisites

- Node 24 or newer
- Deno 2.9 or newer on PATH, used only as a build host for TypeScript/browser
  bundles; set `DENO_BIN` if needed
- An isolated PostgreSQL database with pgvector, reachable from Node
- A browser on the same computer as the two loopback listeners
- An exact locally packed Copilotz candidate with `artifact-manifest.json` and
  `source-manifest.json` beside its tarball; optionally the matching source
  checkout

For a minimal transfer, send this project, the candidate tarball and its two
manifests, then omit the source-checkout argument. That mode records the
builder's source provenance without claiming to compare a local source checkout;
`sourceCheck` in the proof says `recorded-builder-manifest`. The source/build
review must separately establish that provenance before final acceptance.

The candidate must contain the live `client.collections.observe` API. A tarball
built before those changes is not an acceptance candidate. No package is
published by these scripts. Source aliases are not used in the installed build.

## Run from a clean project

Copy this entire directory outside the library checkout, or use it in place. Use
synthetic data and a test database. Set a schema name once and keep that same
value for the restart check.

```sh
export COPILOTZ_TEST_POSTGRES_URL='postgres://localhost/copilotz_demo'
export DEMO_SCHEMA='owner_two_agents_demo'
node scripts/run-candidate.mjs /absolute/candidate/package.tgz /absolute/source-checkout
```

The command verifies the tarball and cross-checks both provenance manifests.
When a source checkout is supplied, it also compares every source-manifest
entry. It installs the candidate through npm, builds the Node server and browser
bundles, runs focused Node tests, then starts the owner. It writes
`dist/package-proof.json`, including artifact/source hashes, installed-file
hashes, dependency-lock hash and tools. The build refuses an installed
candidate, demo source inventory, or dependency lock that changed after
installation. Keep the generated lock and proof with the acceptance evidence.
Demo source hashes are recorded separately from the runtime builder source
hashes. `demoMatchesRuntimeSource` must be true for final acceptance: the
installed example must match the example in the final composed builder manifest.
A mismatch is printed as DIAGNOSTIC ONLY, with the exact mismatched paths
recorded. The older fc929339 diagnostic package is not a final integrated
candidate. Do not reuse its proof after source changes; install a newly frozen
project copy and eventually repack the final composition.

Open `http://127.0.0.1:48942/` in a browser on that computer. Keep one demo tab
open. The dedicated Worker connects to `ws://127.0.0.1:48941/workers`. Both
listeners bind only to `127.0.0.1`. `PORT` and `WORKER_PORT` can change the
ports. The UI intentionally accepts only the printed numeric-loopback origin.

Separate steps, useful when inspecting a failed stage:

```sh
node scripts/install-candidate.mjs /absolute/candidate/package.tgz /absolute/source-checkout
npm run build
npm test
npm start
```

## Acceptance flow

1. Wait for “Browser Worker ready.” Both bounded live selections should load;
   their first snapshots are resets. A build or server-start message alone is
   not a browser pass.
2. Click “Run two-agent flow.” The coordinator and reviewer are enrolled in one
   thread. The coordinator calls the built-in clock, saves a draft with that
   returned time, and invokes Core `ask` for the reviewer.
3. The reviewer also calls the built-in clock, reads that same persisted draft,
   writes a timestamped review and missing rollout checks, and answers. The
   coordinator resumes and publishes the reviewed plan. The plan progresses to
   `published`, contains a rollback checkpoint and post-deploy verification, and
   identifies browser execution.
4. In the evidence View, verify completed facts for the clock, draft, read,
   review, `copilotz.core.ask.completed`, publication and model calls from both
   agents. These records are written by the browser Processor through the owner;
   the UI does not manufacture them from client counters.
5. Record the plan ID, source IDs, run IDs and correlation IDs shown in the
   View. The owner uses `demo-run:<runId>` for both ingress phases. Preserve the
   `/demo/run` response operation IDs and correlations; capture its response
   body without saving the Authorization header or `/bootstrap` capability.
   Facts without a matching run correlation or explicit output run stay
   `unattributed`; never count them as proof for a particular run. Their source
   and causation IDs must be matched to that operation's authorized owner
   records before attribution. A conflicting output run/correlation is refused.
   Click “Replay same run.” Its stable ingress identities must return the
   recorded result without another plan or another set of execution-evidence
   records. New runs intentionally use new IDs.
6. Click “Disconnect worker.” This terminates the real Worker, including its
   WebSocket. Plans remain visible because live reads belong to the owner.
   Reconnect the Worker, then replay the same run. The published result must be
   unchanged. A new run must also complete after replacement.
7. Click “Reconnect Views.” Both subscriptions are aborted and recreated. Their
   reset count increases and the current records replace the selected windows.
   There is no polling cache or raw event replay in the React host.
8. Reload the page. The latest run ID is retained in local storage solely for
   replay; records are read again from the owner. Stop Node with Ctrl-C, restart
   `npm start` with the same database and schema, reload, reconnect and replay.
   Existing plans and evidence must still be present without duplicate writes.
9. For the interrupted-flow case, start a fresh run and immediately disconnect
   its Worker. Reconnect and replay that same run if the first request did not
   confirm success. Record the actual outcome, including any failure terminal;
   do not interpret operation settlement alone as success. Target the window
   after the owner accepts a review/publication mutation and before the Action
   terminal is accepted, recording owner event/Action IDs. The retried Action
   must return that exact mutation result, even if the current row has advanced.
   No duplicate plan, revision, evidence or successful terminal is allowed.
10. Navigate away and Back/Forward, including while a run response is pending.
    Record whether the browser actually used BFCache (`pageshow.persisted`);
    synthetic lifecycle tests do not establish that. A restored page must create
    a new View host, rebootstrap, recreate both selections and replace its
    Worker. Old request/response-body/selection/Worker results must never
    overwrite the restored page. Replay the retained run ID to establish the
    durable result; page closure only abandons the local response observer.

The UI lists the latest 20 plans and 60 evidence records; use a fresh test
schema for an acceptance session so older records do not fall outside those
windows. Preserve the proof, Node logs, browser console/network evidence and
screenshots. Mark each step passed, failed or not run. Actual-browser and
exact-package acceptance remain pending until these steps are performed on that
exact build.

## Authority and lifetime

The Node owner issues one ephemeral, local-only demo capability at process
startup. The same-origin bootstrap hands it to the local page and Worker. It is
never persisted or logged. This is a single-user local acceptance setup, not a
production authentication or worker-isolation design. Do not expose either
listener or use a production database.

Every exposed live Collection requires an owner policy. Only the authenticated
local viewer may read the two demo Collections. Public Collection mutations and
Action routes are disabled. Browser Actions and the evidence Processor receive
only their declared owner-resolved execution identities. The Node process
invokes ingress and drains results; it never runs the demo's plugin handlers.
Custom Actions, the Processor and the model adapter also reject execution
outside a dedicated browser Worker.

The View receives inert snapshot data. Its context has no database, transaction,
adapter, unscoped read or mutation capability. UI gesture callbacks are bound by
the host, refuse execution during View evaluation and are revoked when the host
closes. Late render/worker/subscription results are generation-fenced. Failed
subscriptions clear the corresponding displayed data and offer “Reconnect
Views.” Pagehide aborts bootstrap/run response observation and subscriptions,
terminates the Worker, revokes gestures and closes the View host. Pageshow
creates a fresh lifetime. Closing an HTTP observer does not send durable
cancellation to the owner; it may already have accepted that ingress.

Review and publication use one owner-conditional Collection update with a stable
operation key. The owner checks the predecessor status atomically for a new
mutation. The Action has no precondition read that can block its receipt replay
and no post-write read that can replace the original result with a later row.
Changed intent and unrelated advanced state are refused. Draft creation also
returns the original create result directly.

## What the focused tests prove

`npm test` checks deterministic tool/ask sequencing, failure handling, genuine
View resolution, inert-data rejection, late-render fencing, gesture disposal,
pagehide/pageshow teardown and restoration, late response/body/bootstrap
fencing, and the six-directory layout. A business-state regression loads the
exact Action bodies with an explicit placement spy and exercises the installed
owner Collection kernel in memory: committed-reply loss, replay after later
advancement, intent mismatch, atomic-condition refusal and stable input capture.
It does not dispatch these Actions as Node plugin work or simulate a browser
Worker. It also starts the installed package's real Node gateway with an
in-memory database, verifies an authorized live snapshot, and checks that
anonymous reads and public mutations are denied. That gateway test uses no
browser, listener or execution Worker.

These focused tests do not run an LLM provider, PostgreSQL, a browser, real
two-agent execution, worker replacement or restart persistence. Those remain
separate steps in the acceptance flow above.
