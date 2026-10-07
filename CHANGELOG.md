## Unreleased

### Fixed

- Honor declared scalar Collection ordering in SQL, including numeric sequence
  fields, stable ID ties, nulls and precision-preserving keyset cursors. Reject
  unsupported order fields rather than silently sorting by ID.
- Materialize declared B-tree, GIN and BRIN Collection indexes during explicit
  provisioning, with namespace-scoped B-tree uniqueness, idempotent reuse and
  read-only validation for request-path tenant selection. Existing tenant
  schemas must provision the composed declarations before this release serves
  them; duplicate unique keys fail visibly without rewriting records.
- Select the latest Memory checkpoint across sequence digit boundaries and add
  the matching compound index for automatic reservation.

## 0.85.3 — 2026-10-07

### Fixed

- Reserve automatic consolidation from one captured checkpoint sequence so
  concurrent turns share one database-enforced checkpoint, even with different
  source budgets. Ordinary on-demand semantic writes do not block history work.
- Continue foreground consolidation when another turn has already consumed a
  pending checkpoint. Check chronological boundary advancement, rather than
  treating any different opaque Message ID as progress.
- Keep certified continuity owned by its conversation when peer access changes.
  Retrieve semantic records under current grants instead of copying peer memory
  into the checkpoint. Previously learned continuity remains; future peer reads
  stop after a Space move, detach, archive or removal.
- Bound normal checkpoint selection to one row while preserving shared Agent
  input preparation, provider prefix reuse, Tool continuations and source
  guards.

## 0.85.2 — 2026-10-06

### Documentation

- Organize the guide into six lifecycle parts and 22 progressive chapters, with
  separate paths for the durable runtime and optional agent harness.
- Rewrite subsystem references around application problems, complete examples,
  precise contracts, and focused next steps. Document declarative API, MCP and
  Skill resources, including filesystem plugin generation.
- Verify runnable examples on Deno and Node, including scripted agent failures,
  HTTP access, output cleanup, and the published integration boundaries.
- Clarify database provisioning, observation and history performance evidence,
  deployment ownership, host capability limits, and upgrade procedures.

## 0.85.1 — 2026-10-06

### Fixed

- Expose the private Agent window's thread constraint through the same indexed
  access path as public history. Keep all scope, visibility, branch, anchor and
  cursor checks; preparing history adds no SQL statements.
- Add explicit `provisionCoreHistoryIndexes` provisioning for the
  namespace/collection/thread/time/ID index and its expression statistics.
  Existing schemas can build it concurrently without changing stored Messages or
  the v5 Event schema. Run provisioning once per physical Core schema;
  installing the package alone does not create this index.

## 0.85.0 — 2026-10-06

### Changed

- Index opaque observation selections when events commit. Conversation discovery
  reads indexed selection counters and associations instead of historical event
  metadata. Selection and operation-local event ordinals follow commit order.
- Share scoped discovery, resource checks, operation event hydration and live
  Body reads across observers within each application process. Resource checks
  retain their existing 250 ms cadence and exact permission predicates; missed
  notification hints recover through the five-second safety scan.
- Bound each viewer's queues and renew observations from the last client-applied
  checkpoint when capacity is reached or after five minutes. Completed
  operations retire from cursors, keeping sequential work independent of session
  length.
- Introduce the `operation-selections-v1` cursor and an explicit operation
  catalog upgrade. Stop old writers, run `upgradeOperationCatalog` for every
  physical schema, then start the new version. Core hosts supply
  `resolveCoreObservationKeys`. Existing clients must refresh history and use
  the matching client release.

### Fixed

- Release observers across cancellation during setup, last-viewer disconnect,
  reconnect races, and slow or abandoned HTTP responses. Transport interruption
  never cancels durable operation work.
- Read only the requested indexed BodyStore byte range while following streams,
  avoiding repeated reads of their complete retained history.

## 0.84.3 — 2026-10-06

### Fixed

- Pass the current tenant namespace when estimating prepared memory history,
  including unresolved attachment notices. Historical voice attachments no
  longer prevent an ordinary Agent turn from starting; estimation still reuses
  the normal request formatter without reading attachment bodies or extra SQL.
- Settle exhausted Ask preparation failures through the existing owned deferred
  Tool-plan cursor, including parallel Asks and continuations after Tools. Keep
  transient retries, tenant/ownership checks and ordinary LLM failure handling.

### Added

- Optional durable Processor `onError` recovery after retries are exhausted or
  an error is explicitly non-retryable. A handled durable failure outcome
  acknowledges the delivery; cancellation and lease loss bypass recovery.

## 0.84.2 — Consolidation input budgets

- Budget consolidation from the Agent's prepared prompt prefix and configured
  output allowance, including the maintenance instruction and source manifest.
  Large tool proposals can receive ordinary repair feedback without immediately
  exceeding the input limit.
- Remove the duplicate previous-memory catalogue and the separate
  message-created reservation processor. Threshold checks reuse ordinary
  prepared history; consolidation keeps its typed source, normal Tools, cached
  prefix and certified coverage checks while doing fewer database reads.

## 0.84.1 — 2026-10-06

### Fixed

- Project unknown or unadvertised Tool calls through the existing
  `ToolUnavailable` result path so Agents can correct them. Valid parallel
  siblings still execute, while unavailable stages cannot execute even if a
  later composition registers or grants their alias. This also lets memory
  consolidation recover a misspelled completion Tool in its original scoped turn
  instead of leaving its checkpoint pending after a dead-lettered result.

## 0.84.0 — 2026-10-06

### Changed

- Declare OpenAPI, MCP and Skills as resources. These resources install their
  generated Actions, reader support and default adapter bindings automatically.
  Remove the empty OpenAPI/MCP plugins, public compilers and separate Skill
  constructors; migrate applications to `defineApi`, awaited `defineMcp`, and
  `defineSkill`.
- Load authorized Skill metadata lazily from filesystem or HTTP roots using the
  same import in supported runtimes. Cache bounded app-scoped snapshots and read
  supporting files on demand without executing scripts.
- Compose contributed dependencies through normal plugin registration and
  preserve root overrides, native Action IDs and inferred composition types.
- Support these declarations in filesystem plugin generation and bundled
  plugins, keeping framework imports external to preserve one framework
  identity.

## 0.83.4 — 2026-10-05

### Improved

- Bound operation discovery by eligible operations before resolving their
  associations, reducing repeated historical reads during conversation watching.
- Check outstanding delivery statuses without recounting successful history in
  operation observation and completion waiting. Public settlement counts retain
  their existing meaning. Completion waiting without local work now polls every
  250 ms instead of 25 ms, adding up to roughly 225 ms of polling delay in that
  fallback case.
- Enumerate new operation streams incrementally and coalesce observer catalog
  checks while continuing to notify progressive byte readers.
- Resolve a stream's source Action through a scoped invocation lookup rather
  than fetching historical Events individually.

## 0.83.3 — 2026-10-05

### Improved

- Run the complete release checks only on main updates. Tag publication reuses a
  successful main run for the exact tagged revision instead of testing again.

- Store each consolidation source once and pass scoped, digest-bound references
  through LLM, Tool and repair continuations. Resolve those references from the
  existing history batch while preserving the exact ordinary provider prefix.
- Check each Agent's configured consolidation threshold during ordinary turn
  preparation using its already prepared transcript, including peer history.
  Reserve bounded background work without waiting or repeating source reads.

### Fixed

- Prepare consolidation turns whose frozen source metadata exceeds the 1 MiB SQL
  predicate budget. Verify metadata against the existing batch read before
  opening content, preserving snapshot validation, query counts and the normal
  provider input prefix.

## 0.83.2 — 2026-10-04

### Fixed

- Consolidate memory through the normal typed Agent input pipeline, preserving
  media, reasoning, Tool relationships and the reusable provider prompt prefix.
  Image bytes no longer expand into JSON text during source range estimation.
- Batch history and frozen Context preparation together, avoid a redundant
  source preparation at dispatch, and settle authenticated preparation failures
  without leaving checkpoints pending.

## 0.83.1 — 2026-10-02

### Fixed

- Keep history replay checkpoints valid when a long operation leaves more than
  256 historical stream gaps. Validate optional coverage before accepting it and
  replay uncovered streams within the existing cursor limits.

## 0.83.0 — Optional prerecorded transcription

- Add optional prerecorded transcription plugin with OpenAI and Gemini
  transports.
- Bound audio, provider responses, cancellation and credential/source waits.
  Transcripts use ordinary conversation-history semantics; no new authorization
  framework or database migration.

# Changelog

## 0.84.0

- Declare Skills, OpenAPI, and MCP once as resources with automatic
  dependencies.
- Load skill roots dynamically through the same import across runtimes, with
  bounded app-scoped snapshots and supporting reads.
- Replace descriptor-only API compilation with `defineApi({schema,...})`,
  operation selection, and tool transformations.
- Replace separate MCP preparation with one awaited `defineMcp` resource
  constructor.
- Keep framework dependencies external in filesystem-built plugins and generated
  Skills packages.
- Breaking authoring update: rebuild generated plugins and migrate consumers to
  the documented resource API.

## 0.82.8 — 2026-10-01

### Added

- Import public runtime APIs from `@copilotz/copilotz`: Actions, Collections,
  Processors, plugin authoring, events, content, streams, Engine and
  persistence. Existing narrow runtime subpaths remain available; plugin-owned
  helpers keep their own entrypoints.
- Core's `app.send(message(...))` creates or reuses a conversation when given a
  thread object, enrolls selected registered agents and preserves the caller's
  explicit record IDs. String thread references still require an existing
  conversation. Generated identities include the namespace, and bootstrap
  handles verified concurrent participant and membership conflicts.

### Changed

- Load native async-context support when scoped execution begins, so importing
  runtime authoring APIs does not eagerly load `node:async_hooks`. Scoped
  execution still requires native support and fails before running the callback
  when it is unavailable.

### Documentation

- Rebuild the progressive Getting Started guide for the current API: six
  foundation chapters grow a Notes assistant into reusable application behavior;
  nine optional chapters cover integrations, context, collaboration, interfaces
  and production choices.
- Explain sections, declarations and configuration options inside every new code
  snippet. Update the README, quickstart and navigation to the same import model
  and Core-only first message.

## 0.82.5 — 2026-09-29

### Added

- A failed Processor now says why. The `worker_handler_settled` delivery
  diagnostic carries `error: { name, message }` when the handler threw, next to
  the delivery's new status (`retry_wait` or `dead_letter`), so
  `onDeliveryDiagnostic` can log background failures. The message is cut to 500
  characters and masks common credential shapes; the stack, the cause, and the
  Event are never included. See "Seeing why a Processor failed" in
  `docs/events-deliveries-recovery.md`.

### Changed

- Actions that declare content input (including `callLlm`) accept a plain string
  as text, both in place of a whole sequence and as an element of one, so
  `{ role: "system", content: "Be brief." }` works. Other shapes are still
  rejected as before.
- The error for a missing tenant namespace now says how to set one. Copilotz
  still never picks a namespace for you; a default would let a forgotten tenant
  silently share data.

### Documentation

- The README and quickstart explain the namespace, and the Node install line
  sets `"type": "module"` so a fresh project runs `room.ts` without a warning.

## 0.82.4 — 2026-09-29

### Added

- `coreStreamAgent(output)` from `@copilotz/copilotz/core` returns the Agent
  (`{ id, name }`) speaking in a stream Core produced, so code reading
  `send().outputs` can say who is talking without relying on stream metadata.
  The interactive CLI uses it.

### Documentation

- Rewrite the README and quickstart around rooms with several people and agents:
  an example with two people and two agents, then serving it over HTTP and
  adding a chat UI.
- Document shared rooms in the server guide: granting several people access to
  one conversation from `authorize`, including `coreConversationAccess`.
- Reorganize the documentation index, and stop publishing internal design notes
  (moved to `design/`).

## 0.82.3 — 2026-09-29

### Added

- The default embedded application has `fetch(request)`, like a Gateway. With
  `serverPlugin` composed it serves the `/api` facade, so a single-process web
  application needs one `createCopilotz()` call and any Fetch listener. Without
  `serverPlugin` it answers 404.

## 0.82.2 — 2026-09-29

### Added

- Add `AgentResource.history.maxAgeMs` to bound authorized conversation history
  by the durable trigger timestamp. `dynamicResolve` can override the policy for
  one turn; omitted policy keeps the complete history.

## 0.82.1 — 2026-09-29

### Fixed

- `close()` no longer crashes the process after successful work. Each stream
  output's terminal wait kept polling the database after it closed and rejected
  unhandled on Node and Deno. Shutdown now ends these waits.
- A send whose work dead-lettered now names the cause, for example
  `… contains dead-lettered work. <consumer>: Thread 'x' was not found.`, and
  carries it as the error's `cause`.
- PGlite now opens on Node and Bun without a custom `pgliteProvider` (Ominipg
  0.9.1). Install `@electric-sql/pglite` alongside Copilotz.

### Added

- `isStreamOutput` from `@copilotz/copilotz/streams` narrows an Application
  output to a progressive stream.
- Deliveries can be listed by settlement scope.

### Documentation

- The README and quickstart examples run as written. They create the thread
  through web channel ingress, use a real model, and import `defineTool` from
  `/core`.

## 0.82.0 — 2026-09-28

### Breaking

- `EventStore.succeedDelivery` and `cancelDelivery` now return the settled
  `EventDelivery` (or `null` when the delivery was not in a settleable state)
  instead of a boolean. Callers that only test truthiness are unaffected.

### Performance

A reply that calls one tool went from about 770 SQL statements to about 130
(measured with the latency probe on Postgres). With a 5 ms database round trip
that reply takes about 0.9 s end to end.

- Commit each durable event, with its body, deliveries and operation index, as
  one statement. Commit each collection write and its graph projection as one
  statement, including the assets the write adopts.
- Run a tool plan inside the deliveries that advance it: one tool call takes one
  processor hop instead of five. The coordinator no longer subscribes to the
  tool-plan intermediate events; their handlers remain for deliveries created
  before this release.
- Hand committed events to local consumers without re-reading them, and wait on
  the executor's in-flight work instead of polling for settlement.
- Claim an Action run with its invoked receipt and retain its input assets in
  the same statement.
- Read what a question needs once: collection gets issued together are one
  statement, a snapshot answers a repeated read once, and a handler reads a row
  once (its view lasts for that handler, at most two seconds, and is voided by
  the runtime's own writes; another process's write is seen by the next
  handler).
- Prepare a prompt's messages in one pass: one list of the stored messages, one
  read of their asset rows, and one resolution of the bodies. The byte limit is
  now measured in stored bytes, the measure the resolver enforces.
- Report a succeeded delivery's row with its result instead of reading it back.

### Changed

- Adopt Ominipg 0.9.0.
- Add a single membership path for messages, and cancel S3 response bodies when
  GET metadata fails validation, so the connection is released.

### Documentation

- Size the connection pool from the turns in flight: at least 1.5 connections
  per concurrent turn (see `docs/embedding-and-hypervisors.md`).

## 0.81.0 — 2026-09-28

### Breaking

- `buildLlmTranscript` and `prepareLlmTranscript` from `@copilotz/copilotz/core`
  now return `{ sourceId, message }` entries instead of bare `LlmMessage`s, and
  `buildLlmTranscript` no longer takes a source callback. `participantId` is now
  required on both. Use `entry.message` for the previous value.

### Changed

- Label every model-facing user turn that has a `name` as `[Name]: …`, so agents
  can tell humans and peer agents apart. The speaking agent's own turns stay
  unlabelled. Existing threads get one prompt-cache miss when this ships.
- Give the asking agent an Ask answer as the output of its `ask` tool call,
  instead of an empty tool result followed by a separate user turn.
- Send adjacent tool results as one `<tool_results>` block.
- Show other agents' tool results as status lines such as
  `[North used weather: completed]`, followed by the output only when the
  result's history visibility is `public`. `public_status` bodies are never
  opened for other agents, and `requester_only` results stay invisible.
  Previously `public_status` results were dropped and `public` output appeared
  as `[tool]: …`.
- Keep another agent's visible text on turns where it also called tools.

### Fixed

- Send `llm.call` tool results that have no `toolPlanId` as `<tool_results>`
  linked to their call. Previously they reached the model as bare user text.
- A peer agent's malformed stored tool call no longer fails other agents'
  transcripts.

## 0.80.9 — 2026-09-28

### Performance

- Batch selected thread memberships with message creation to avoid repeated
  enrollment Actions and durable transactions.
- Reuse immutable Ready-object metadata during S3 body reads and promotion,
  avoiding redundant metadata requests.

## 0.80.8 — 2026-09-27

### Fixed

- Restrict prepared conversation snapshot reads to indexed message IDs before
  checking the full captured snapshot. This reduces PostgreSQL CPU work for long
  transcripts while retaining the check before content is opened.
- Index operation metadata associations so repeated thread operation queries can
  locate matching operations without scanning the catalog.

## 0.80.7 — 2026-09-26

### Fixed

- Encode inline media in the HTTP conversation client so image content survives
  JSON submission and reaches model history.
- Keep browser-uploaded non-image files on their existing attachment-reference
  path.

## 0.80.5 — 2026-09-24

- Give each parallel Tool pipeline its own durable branch cursor so sibling
  completions do not contend on one mutable plan record. Project the ordered
  Tool messages once after every branch settles.
- Migrate in-flight plans on access and keep legacy coordinator events
  compatible. Retry transient PostgreSQL and collection conflicts around state
  transactions without rerunning completed Tool Actions.

## 0.80.4 — 2026-09-24

- Bound oversized Tool results when preparing model and Memory transcripts,
  including results already stored in conversation history. Keep the original
  result durable and show a compact marker instead of spending the input budget
  on its full body.
- Add the automatically available `readToolResult` Tool for authorized agents to
  retrieve a bounded UTF-8 slice or search for literal text by Message ID.
  Configure inline, read, and source-size limits through Core's `toolResults`
  resource.

## 0.80.3 — 2026-09-24

- Prepare each built-in model's final provider transcript before starting a
  durable LLM call. When every route exceeds its input limit, Core compacts the
  conversation first and retries with a fresh request.
- Pin the token calibration used for admission through the provider attempt and
  verify the prepared transcript before network I/O. This prevents a calibration
  change between routing and execution from turning a recoverable oversized
  prompt into a failed conversation response. Custom adapters keep their
  existing generic input estimate.

## 0.80.2 — 2026-09-23

- Let memory maintenance consolidate a single tool result that exceeds the
  former one-third source limit while keeping each checkpoint below half of the
  model input budget. This restores forward progress for existing threads with
  large indivisible results without changing stored history or coverage.

## 0.80.1 — 2026-09-22

- Resolve text and JSON references in completed HTTP Action results after
  protected-output recovery, restoring readable coordination history and search.
  Durable values and Action inputs retain canonical references; binary content
  and refs marked `resolve: false` remain unloaded. No migration is required.

## 0.80.0 — 2026-09-22

- Make channel HTTP admission optional and expose `submitChannel` for trusted
  hosts to submit validated Core occurrences through ordinary application sends.
- Add `createChannelSession` for ordered live replies, explicit interruption,
  late-admission cancellation, and suppression of obsolete outputs.
- Add Core's `projectCoreReply` to select resolved body text within an explicit
  operation, thread, agent, and viewer scope without extra content reads.
- Filter detached provider egress by conversation visibility and content role,
  retaining durable retries and stable delivery identity. Built-in external
  providers explicitly use public conversation visibility; custom and Web
  channel defaults remain participant-scoped. Preserve public metadata-only
  presentations such as carousels for adapter-specific delivery.
- Resolve text and JSON Asset refs recursively in Processor Events, engine
  outputs, application observations, and replay reads. Durable Event envelopes
  retain canonical refs; binary refs remain metadata-only.
- Reuse a bounded, process-local prepared-body cache after committed Asset and
  Collection writes, avoiding an immediate body-storage read without changing
  authorization or integrity checks.
- Update native channel, memory, and schedule Processors to consume the
  immutable `event.data` snapshot. Channel egress carries that message snapshot
  into its Action while retaining current sender and binding checks.

- Keep internal worker relay events reference-based and resolve public output
  data at the gateway. Bound resolved HTTP output envelopes separately from
  binary chunks and preserve the last successful cursor on capacity failure.
- Cancel active CLI operations and stream readers on shutdown, including
  interruption after output EOF while durable completion is still pending.

## 0.79.1 — 2026-09-21

- Expose the cohesive low-level `copilotz/engine` runtime for operator-owned,
  durable collection migrations. It accepts a static plugin registry and an
  injected SQL session without starting a Gateway or Worker.

## 0.79.0 — 2026-09-21

- Make each Space-owned Collection declare
  `space: relation.belongsTo("space",
  "spaceId")`; `spaceId` is now the sole
  ownership record and the runtime projects the ordinary `has_<resource>`
  relation.
- Make Core Space moves, detach, removal, memory reads, and scheduled-job safety
  checks use the resource relationship directly. The historical
  `spaceAttachment` Collection remains registered only for durable replay and
  deployment migration compatibility.

## 0.78.2 — 2026-09-21

- Accept legacy `tool_plan_id` metadata in canonical LLM tool-call blocks and
  discard it before assigning the server-owned Tool plan. Providers that copy
  historical Tool metadata no longer trigger a malformed-tool-call retry.

## 0.78.1 — 2026-09-20

- Recognize `claude-opus-5` adaptive thinking and its default-on behavior while
  preserving signed thinking blocks and provider effort mappings.
- Allow HTTP adapters to declare bounded raw or parsed request bodies per route;
  enforce the same limit before authentication body reads and handler parsing.
  Default limits and Asset upload policies remain unchanged.

## 0.78.0 — 2026-09-19

- Move Skills metadata and usage guidance into plugin context and instruction
  contributions; retain lazy, policy-bound content readers.
- Add the declaration-only `collections/authoring` entry so generated Skills
  plugins avoid importing the server runtime in browsers.
- Preserve textual JavaScript, XML, and SVG resources and promptly cancel
  stalled content streams. Durable capability recovery now receives real Action
  callers.
- Narrow the Core resolved skill resource type to its domain-neutral name
  contract; consumers needing Skill-specific fields should use the Skills type.

## 0.77.0 — 2026-09-18

- Replace the instruction-only Agent resolver with `dynamicResolve`, which
  resolves effective instructions and model selections from one read-only turn
  snapshot and records a durable configuration revision for the prepared call.
- Add atomic plugin-owned Thread system-metadata patches so applications can
  persist optional thread configuration without overriding the Core collection.
- Add opt-in, policy-bound Server Collection mutations and matching client
  helpers. Collection writes remain durable and authorization-constrained;
  Actions remain for multi-resource orchestration.

## 0.76.7 — 2026-09-17

- Synchronize the lockstep frontend package release for preserved streamed-turn
  ordering. Core runtime behavior is unchanged.

## 0.76.6 — 2026-09-17

- Synchronize the lockstep frontend package release for stable streamed
  responses and tool activity. Core runtime behavior is unchanged.

## 0.76.5 — 2026-09-17

- Render LLM tool input schemas as generated TypeScript contracts, with a
  generic fallback for schemas that cannot be represented.
- Expose the transaction-aware `attachSpaceRecord` helper for canonical, atomic
  Space record attachment and moves.
- Add an optional `requireEmpty` guard to Space removal so attached records can
  block deletion when requested.

## 0.76.4 — 2026-09-17

- Allow authorized applications to update a Space's canonical name and optional
  description through Core's Space Action. Existing Spaces remain compatible; an
  explicit empty description clears it.

## 0.76.2 — 2026-09-17

- Use operation-change hints for targeted live discovery instead of repeatedly
  scanning unchanged history every 250 ms.
- Retain initial discovery and a five-second recovery scan for missed hints,
  with bounded pending IDs and listener cleanup on cancellation or failure.
- Stabilize filtered event-watermark reads against PostgreSQL backward-index
  plans that can scan unrelated history. Namespace-only reads retain their
  indexed maximum query.
- Preserve discovery SQL, schema, authorization and replay checkpoints.

## 0.76.1 — 2026-09-17

- Detach observations that finish attaching after request cancellation.
- Validate operation discovery from the catalog metadata already selected,
  avoiding repeated operation-status settlement work during every discovery
  poll.
- Preserve replay, authorization and the existing observation interval. Schema
  v5 and its indexes are unchanged.

## 0.76.0 — 2026-09-17

- Move Core HTTP operation discovery, membership and event-watermark SQL behind
  generic operation-catalog reads using the existing metadata index.
- Add operation/event metadata associations, progress filtering and generic
  event watermarks to the catalog API. Empty operation ID selections return no
  records.
- Remove the catalog’s exposed SQL session and table names. Core retains
  conversation criteria; runtime owns SQL and namespace-scoped lookup mechanics.
- Keep schema v5 and its generic indexes; no conversation-specific index is
  required by the new queries. Older consumers must be upgraded before removing
  a temporary index installed for their query paths.

## 0.75.1 — 2026-09-17

- Bound thread operation discovery to the associated operations before applying
  state and progress filters, avoiding repeated whole-history progress scans.
- Document the online event-metadata index required for efficient Core thread
  observation on existing databases.
- Read each unique message sender once per history page.

## 0.75.0 — Unreleased

- Remove frontend conversation-tag fields and metadata mutation support.
- Keep scheduled messages within their owning Space. Moving or detaching a
  target conversation pauses affected jobs; queued delivery checks ownership
  under the same transaction fence as attachment changes.
- Skip stale queued occurrences after a job is retargeted, and expose explicit
  sent/skipped dispatch outcomes.

## 0.74.1 — Unreleased

- Forward the consumer's Deno configuration to the published build command's
  type check, validation and ESM bundle subprocesses.

## 0.74.0 — 2026-09-16

- Add the build-host-only `copilotz build` command: deterministic convention
  discovery, native composition validation, generated TypeScript and bundled
  ESM.
- Convert all 24 library plugin roots to static declarations using the same
  conventions. Remove plugin factories and compatibility wrappers.
- Resolve synchronous contributions through the generic composition protocol;
  object-form tools register native Actions directly from `resources.tools`.
- Compose root resources, adapters, Actions, Collections and Processors before
  startup. Plugins read configuration and capabilities from the final context.
- Remove redundant freezing and factory layers from plugin authoring. Keep build
  tooling out of browser and Cloudflare runtime graphs.
- Document conventions, context configuration and breaking migration steps.

## 0.73.0 — 2026-09-15

- Add Core Spaces with owner/member Participants, custom-record attachments,
  atomic moves, archive/restore and non-destructive removal.
- Resolve read-only peer Thread memory consistently across search, consolidation
  and prompt context. Revoke derived access on detach, move, archive and
  removal; preserve producer scopes, write targets and provenance.
- Reject consolidation lifecycle changes to peer memory and exclude inaccessible
  checkpoints from prompt context.
- Document the application authorization boundary and cover persistence,
  concurrent attachment collisions, paginated cleanup and live peer recall.

## 0.72.0 — 2026-09-13

- Capture provider-native reasoning as Assets in Agent history and replay it on
  compatible later turns across the OpenAI, Anthropic, Gemini, Groq, DeepSeek,
  MiniMax, and Ollama adapters.
- Replay native reasoning only for the same Agent when its adapter, API, and
  model remain compatible. The tool protocol is unchanged.
- Keep Groq reasoning output-only. DeepSeek ignores native reasoning input when
  native tools are unavailable.

## 0.71.2 — 2026-09-13

- Recover terminal tool status in thread history when the invocation is visible,
  even when its result is requester-only. Preserve private result bodies and
  hidden invocations, and apply authorization before visible pagination.
- Cover exact reads, pagination, invocation ownership, and private asset
  isolation.

## 0.71.1 — 2026-09-10

- Fill memory consolidation's bounded source budget before reserving a
  checkpoint, instead of invoking maintenance for each small read batch.
  Preserve recent history and a safe prefix when a later source exceeds the read
  budget.
- Cover consecutive large-backlog checkpoints, uneven retained tails, and later
  oversized sources with deterministic regression tests.

## 0.71.0 — 2026-09-09

- Include the existing main-branch refactor that places plugin primitives in
  their owning modules.
- Add the native GCS BodyStore with Cloud Run metadata-service bearer
  authentication by default and an application-owned authentication callback.
- Use immutable conditional uploads for Ready Bodies, generation-pinned reads,
  and database-staging promotion composed into the final object.
- Do not perform automatic GCS garbage collection. No database migration is
  required, and Event JSON Bodies remain stored in the database.

## 0.70.2 — 2026-09-09

- Consolidate bounded chronological history across unfinished Tool and Ask
  calls, preserving execution identities and late answers across summary
  boundaries.
- Share detailed proposal validation and checkpoint reservation while preserving
  semantic-memory authorization and atomic settlement.
- Read and validate exact checkpoint ranges, including endpoint authorization,
  and avoid reloading successful content batches during source selection.

## 0.70.1 — 2026-09-09

- Keep foreground Agent answers waiting for certified memory consolidation, with
  durable progress and cancellation.
- Bound compaction source hydration and preserve complete Tool/Ask dependency
  groups when selecting history prefixes.
- Validate consolidation continuity outputs and clarify continuation summaries,
  including no-change results.
- Reject oversized content before loading asset bodies with an explicit content
  budget error.

## 0.70.0 — 2026-09-08

- Prepare each new Agent invocation from the latest authorized history for its
  Agent and scope. A durable Action captures its prepared request and metadata
  once, preserving the original request on recovery.
- Replace moving conversation-history and LLM input cutoffs with certified
  memory-compaction coverage and bounded, explicit input-limit failures.
  Compaction preserves private visibility, active branches, unfinished Tool/Ask
  groups, and replay-safe checkpoint invalidation.
- Add read-only repeatable-read snapshot support for preparation, and expose
  bounded delivery diagnostics through the public application surface.
- Derive a stable, trusted subscription session identity from the resolved
  account, namespace, thread, and Agent for built-in ChatGPT routing and prompt
  cache keys. Credentials remain runtime-only; no provider turn-state replay is
  introduced.
- Preserve normalized, credential-safe Memory checkpoint failure diagnostics.
  Existing database schemas, Events, Messages, Assets, and public HTTP routing
  remain compatible; no database migration is required.

## 0.69.1 — 2026-09-07

- Add case-insensitive exact and set string predicates for Collection reads and
  aggregate filters while preserving scoped authorization intersections.

## 0.69.0 — 2026-09-07

- Add durable Usage ledger aggregation, authorized analytics and bounded attempt
  drill-down, plus the `/usage/client` browser-safe client export.
- Record the selected safe LLM connection alias and cache-creation input tokens
  when providers report them.

## 0.68.0 — Explicit LLM connections

- Replace Model resources and credential registries with explicit connection,
  model, and per-selection options. This is a breaking LLM and Agent
  configuration change.
- Add process-local static/dynamic LLM connections and a reusable ChatGPT token
  refresh helper with conditional persistence callbacks.
- Preserve provider fallback, progressive streams, cancellation, and usage
  reporting; reject authentication configuration in durable model selections.

## 0.67.4 — 2026-09-07

- Synchronize with the Admin facade integration and authenticated tenant scope
  release. Runtime behavior and stored data are unchanged.

## 0.67.3 — 2026-09-07

- Synchronize with the frontend streaming recovery and tool-output release.
  Runtime behavior and stored data are unchanged.

## 0.67.2 — 2026-09-06

- Automatically route GPT-6 Astra through the Responses API and forward its
  configured reasoning effort, including low and high.

## 0.67.1 — 2026-09-06

- Reconcile concurrent Collection content adoption before committing records and
  Events, so identical parallel questions share the winning Asset safely.
- Coordinate Collection and standalone Asset writers using ordered transactional
  locks without rerunning Action handlers or transaction callbacks.
- Preserve canonical references, manifests, replay, and genuine conflict
  rollback.

## 0.67.0 — 2026-09-06

- Unify scoped Collection execution and runtime-owned content preparation,
  resolution, strict decoding, and durable Action inputs.
- Resolve authorized Core history in the runtime and return metadata plus typed
  values; exclude private tool bodies and pagination lookahead from resolution.
- Add a browser-safe content codec export and resolved Core client message
  types.
- Integrate prepared content throughout Core and LLM consumers without changing
  persisted conversation or Asset formats.
- Coordinate with the frontend adapter that consumes inline history values.

## 0.66.7 — 2026-09-06

- Synchronize with the frontend release that scopes preparation activity to each
  Agent's model invocation. No server protocol or persistence changes.

## 0.66.6 — 2026-09-06

- Restore history-aware stream checkpoints and bounded snapshot catch-up over
  multipart observations.
- Correct descending history pagination and preserve older-page cursor
  direction.
- Retry interrupted observation reads without fabricating failed stream
  outcomes.
- Keep stream-origin caches bounded without limiting the total Actions in long
  runs.

## 0.66.5 — 2026-09-06

- Project authorized public tool status into conversation history without
  exposing private output or asset access.
- Preserve requester-only tool visibility and exact execution/source identities.

## 0.66.4 — 2026-09-05

- Clarify parallel tool-call framing and malformed-call repair instructions.
- Permit Model fallback after reasoning and speculative tool drafts while
  preserving distinct stream identities and failed outcomes. Published answer
  and media output still prevent fallback.

## 0.66.3 — 2026-09-05

Authorize conversation Asset reads through their owning thread and message,
including exact content and reasoning references. Filter private history before
pagination and expose the typed Core message Asset client. Content reads no
longer depend on an asynchronous application access projection. Existing
messages, Assets, and database schemas remain unchanged.

## 0.66.2 — 2026-09-05

Restore independent conversation participant selection and message recipients.
The canonical send Action enrolls selected agents before delivery, including
missing teammates on existing threads, without broadcasting the message to them.
Keep authenticated ownership and ask membership/capability checks intact.

## 0.66.0 — 2026-09-05

Replaces all versioned HTTP implementations with one compiled `/api` facade.
Adds browser-safe generic and Core clients, exact HTTP Adapter composition,
policy-constrained reads, durable operation receipts and multipart observation.
Core conversation mutations use ordinary Actions; history and reconnect reuse
existing checkpoints and replay. Existing schemas, Events, Collections, Assets
and identifiers remain unchanged. This is a coordinated breaking HTTP release.

## 0.65.4 — 2026-09-02

Adds generic Action-run provenance to progressive streams. Transports can now
order a durable Action result after only that Action's streams, without blocking
it behind unrelated lanes in the same operation.

## 0.65.3 — 2026-09-02

Publishes the semantic-memory public read boundary from this release line.
`search_memory` returns a bounded public summary and `inspect_memory` returns a
bounded semantic detail, both with closed output schemas. Storage internals are
not projected; results, sources, and relations have explicit budgets and
truncation/count semantics while preserving memory-space authorization.

## 0.65.2 — 2026-09-02

Closes the public read boundary for semantic memory. `search_memory` now returns
a bounded public summary and `inspect_memory` returns a bounded semantic detail,
both with closed output schemas. Storage internals—including embeddings,
namespaces, memory-space/thread/consolidation identifiers, and edge metadata—
are never projected. Results, sources, and relations have explicit budgets and
truncation/count semantics while preserving memory-space authorization.

## 0.65.1 — 2026-09-01

Preserves bounded, sanitized error details from structured OpenAPI and NDJSON
tool responses, including terminal errors carried by successful HTTP streams.
Opaque response payloads continue to use a fixed safe fallback.

## 0.65.0 — 2026-09-01

Breaking: progressive streams now have one retained terminal contract. Body
stores must expose ranged reads, renewal, and terminalization; published streams
always settle with a canonical terminal outcome, including retained failed or
cancelled prefixes. Replay cursors use only operation-local lane ordinals, and
malformed LLM tool-call attempts are retained as bounded, canonical failure
evidence rather than speculative action calls.

## 0.64.3 — 2026-08-31

Fixes long-running conversation history after a Thread exceeds 1,000 Messages.
Collection cursors now use stable ordered keysets, Core routes from one
trigger-anchored, branch-aware chronological snapshot, and public history pages
the true newest records instead of truncating the oldest prefix. Thread activity
also selects the latest Event correlation without an oldest-page cutoff.

## 0.64.2 — 2026-08-31

Fixes reconnect history while an operation is active in a tenant database
schema. Message history now checkpoints active operations in the same trusted
schema scope, avoiding transient `operation_not_found` responses on refresh.

## 0.64.1 — 2026-08-31

Clarifies the storage-provider compatibility boundary used by the Compass/GCS
interoperability hotfix. AWS Signature Version 4 HMAC clients must select
`provider: "s3"`; `x-goog-*` coordination requires GOOG4 signing and is not safe
through `s3-lite`. Storage behavior is unchanged in this metadata-only patch.

## 0.64.0 — 2026-08-31

Adds durable, reconnectable application operations. A submitted root Event is
now also the generic operation identity; callers can detach an HTTP observer
without cancelling durable work, resume ordered Events and progressive Bodies
from an opaque cursor on any replica, inspect operation state, and issue an
explicit idempotent cancellation. The Server facade supports asynchronous
receipts, operation output feeds, thread feeds, replay cursors, and SSE
keepalives. Additive operational tables index discovery and offsets while
canonical Events and Assets remain the state and payload authorities.

Progressive storage is now bounded and maintainable across every built-in Body
backend. Live process buffers are released and capped, database parts compact at
seal, crashed filesystem/object staging is enumerable and retry-cleanable, and
temporary observation Bodies expire through guarded maintenance. LLM frame
writes are coalesced, and an exact media-type/length/digest match dynamically
reuses the streamed Body for the normalized final Asset; non-equivalent output
keeps its separate canonical Asset without duplicating a stream Asset.

## 0.63.9 — 2026-08-31

- Semantic memory now distinguishes an object's lifecycle from its editorial
  validity. Records carry `valid`, `retracted`, `superseded`, or `archived`
  validity, and ordinary context, consolidation, and search exclude records that
  are no longer editorially visible while history and inspection retain them.
- Adds the narrow, provenance-bound `invalidate_memory` tool for retraction,
  supersession, and archival. It preserves domain lifecycle, enforces writable
  memory-space access, is idempotent for identical retries, and rejects
  conflicting dispositions.
- `consolidate_memory` publishes a discriminated public input schema and an
  auditable output contract with canonical created/reused record IDs. Invalid
  on-demand consolidation now settles its owned pending checkpoint as failed.

## 0.63.8 — 2026-08-29

- Persistence now recognizes typed Oxian session-loss outcomes, retires the
  affected OminiPG generation, and returns a bounded indeterminate error without
  replaying the in-flight database operation.
- OminiPG advances to `0.9.0-rc.11` and Oxian to `0.21.1`. In-process workers no
  longer self-expire after a request-scoped CPU pause, while WebSocket workers
  retain heartbeat lease fencing.

## 0.63.7 — 2026-08-29

Makes Gateway delivery recovery continuous and restart-safe. Gateways now sweep
already-ready persistence before serving, arm one schema-scoped wakeup for the
next persisted retry or lease-expiry deadline, and recover dynamically opened
database scopes. A process that restarts before an abandoned lease expires can
therefore resume the delivery after expiry instead of leaving it permanently
leased. Worker roles remain passive, filtered recovery cannot widen its scope,
and recovery timers are cancelled at shutdown.

## 0.63.6 — 2026-08-29

Adds bounded raw Asset uploads to the compiled Server facade. `POST /assets`
publishes directly to the configured Asset body store, supports exact idempotent
replay, and returns a canonical attachment ContentRef without copying bytes into
Action or Event payloads. Streaming request limits are enforced while consuming
the body, including chunked uploads without a declared content length.

LLM calls now preserve the ContentRef disposition boundary: attachments and
unspecified files become deterministic `asset://` descriptors for Asset Tools,
while only explicitly inline content is materialized into provider requests.

## 0.63.5 — 2026-08-28

Routes semantic-memory consolidation through the owning Agent's ordinary Core
Message, prompt, Model, credential, Tool-plan, Ask, and Action lifecycle. A
generic private Agent-turn scope keeps background work out of public history,
while `consolidate_memory` remains available in ordinary turns and provider
prompt prefixes stay cache-compatible. The obsolete Memory-owned Model list,
maintenance Action, direct LLM loop, and manual Tool parser are removed.

Also adds trusted shared prompt-instruction Resources, durable channel thread
membership, recoverable model-authored Tool input validation, explicit
scheduled-message recipient selection, correlation-scoped thread activity, and
safe progressive-stream failure diagnostics.

## 0.63.4 — 2026-08-26

Keeps routed LLM work inside the originating durable settlement scope so Web
Channel request observation remains open through delayed Agent output and
cancels provider work with its parent request.

## 0.63.3 — 2026-08-25

Aligns the retained package-configuration contract with the JSR-safe explicit
self-import graph introduced in 0.63.2.

## 0.63.2 — 2026-08-25

Restores explicit package self-import mappings for every public export so JSR
can construct the publication module graph. The package-surface gate now
requires those mappings to mirror `exports` exactly.

## 0.63.1 — 2026-08-25

Adds the schema-level Secret lifecycle, compiled Server façade, named Collection
query schemas, and trusted event recovery required by the Compass 0.63
migration. Secret-bearing Action values are encrypted through a process-local
Adapter, remain redacted in ordinary observation, and never become public
Assets.

## 0.63.0 — 2026-08-25

Final plugin-first runtime and deployed-data migration release.

### Breaking

- The root now exposes one application factory and the narrow
  `{ send, observe, close }` surface. Runtime internals, semantic DTOs, and host
  capabilities live on explicit subpaths or inside their owning plugins.
- LLM calls and every concrete Tool are native Actions. Built-in providers are
  selected directly by ordered Model Resources; custom LLM Adapters remain
  application-owned. Tool Resources are data-only presentations of the same
  Action aliases Core invokes.
- Channels, Memory, Knowledge, Skills, Schedules, Usage, and Admin are ordinary
  plugins built from Collections, Actions, Processors, Resources, and Adapters.
  The former Goals workflow plugin is replaced by the local Core `runGoal`
  authoring loop over settled application sends.
- `/domain`, `/attachments`, `/adapters`, `/adapters/node`, `/migration/v1`,
  `/migration/content-v2`, and `/migration/memory-v4` are removed.
- Provider-aware token estimation moves from the generic `/tokens` subpath to
  `/llm/tokens`; mutable calibration is now private to the LLM plugin.

### Added

- Generic application stream observation through `/streams`, with one
  subscriber-owned byte follower per `stream.output` descriptor.
- Resolved immutable Event data on `send().outputs` and `observe()`, retaining
  each durable Event's original body reference.
- Minimal target/lead Goal conversations through `/goals#runGoal`; ordinary Core
  Messages and Action lifecycles remain their only durable record.
- Core-owned conversation contracts, projections, and portable CLI adapters on
  `/core`, `/core/cli`, and `/core/cli/node`.
- Parallel Tool branches with sequential `jq` pipelines, durable fan-in, nested
  Agent asks, public/private Ask history, and participant-aware CLI streaming.
- Frozen Agent instruction hooks, Tool/API authoring helpers, reusable dynamic
  LLM credential Resources, and built-in provider Models that require no
  manually instantiated provider Adapter.
- Per-provider-attempt Usage accounting. Framework-rejected streams drain to
  final metering before recovery, while credentials remain process-local and
  absent from Action lifecycle data.
- OpenAPI response Asset promotion for configured data URL/base64 fields, with
  canonical Asset references replacing raw media payloads.
- The sole deployed-data migration, `/migration/v4#migrateToV4`, for the exact
  legacy graph profile used by Copilotz 0.47/0.48. It archives old tables,
  creates ordinary v4 source Events, rebuilds and verifies projections, and
  writes the v4 readiness marker only after successful verification.

### Verified

- A frozen real Gilpinna 0.48 PGlite fixture preserves all 12 messages and both
  original Asset byte streams, resumes after a crash immediately before the
  readiness marker, and continues through the final Core/LLM seam.
- The package passes the complete type, architecture, boundary, runtime test,
  and publish dry-run ladder.

## 0.62.1 — 2026-08-24

Published the initial plugin-first v4 baseline and repaired its PostgreSQL
schema-readiness gate. Version 0.63.0 finalizes the physical plugin layout and
public package surface before 1.0.

## 0.61.0 — 2026-08-18

Plugin-first event-sourced core. Conversation collections, text/ask processors,
and bundled vendor adapters ship on `@copilotz/core`. Runtime keeps host
mechanism and does not own a vendor catalog.

### Added

- Static `corePlugin` / `coreCollectionsPlugin` with participant, thread, and
  message Collections plus LLM and Tool Features.
- `llm` resources expose `generate()`. Shipped adapters live on the core plugin
  as `{ id, type: "llm", generate }`.
- `copilotz.core.thread-message` `create` feature for ensure-participant, thread
  membership, and `message.create` in one transaction.
- Direct Feature action calls through `context.features.<alias>.<action>(...)`
  and `context.feature(definition).<action>(...)`.
- Persisted Feature Action lifecycle events derived automatically from the
  Feature/action identity; operational LLM/tool Collections are gone.

### Changed

- Core processors and writes use bound collections and `CollectionRecord`.
  Application ingress is `send(core.message(...))`; session output is observed
  through `observe()`.
- `chat()` requires an explicit provider registry. No hardcoded vendor map in
  runtime. `generateFromFactory` binds one adapter as one resource.
- Package-root `createCopilotz` injects `canonicalCore: [corePlugin]`.
- `agent.runtime` replaces `llmOptions` and `runtimes.text` /
  `runtimes.realtime`. Same-mode `fallbacks` feed `runGenerateChain`.

## 0.60.18 — 2026-08-15

- Treat the successful signed conditional PUT as the canonical acknowledgement
  for new immutable objects, removing the redundant post-upload HEAD while
  retaining HEAD-based verification for resumable conflicts.
- Feed each byte-bounded body slice continuously through the upload pool instead
  of imposing upload-count synchronization barriers.

## 0.60.17 — 2026-08-15

- Permit up to 128 concurrent object writes for high-latency small-asset
  migrations while bounding each fetched body slice by a configurable total byte
  budget.

## 0.60.16 — 2026-08-15

- Fetch database asset bodies in upload-sized SQL batches before bounded
  concurrent object writes, eliminating one database round trip per asset while
  retaining the upload-concurrency memory cap.

## 0.60.15 — 2026-08-15

- Relocate database assets through metadata-only keyset pages and fetch one body
  per active uploader, bounding resident body memory by upload concurrency
  instead of page size.
- Add an interruption-safe partial relocation index so resumable runs avoid
  repeatedly scanning unrelated graph nodes.

## 0.60.14 — 2026-08-15

- Release completed S3-compatible PUT response streams immediately, avoid
  copying upload buffers, and isolate decoded bodies in short-lived page frames,
  keeping long-running object relocation memory-bounded.

## 0.60.13 — 2026-08-15

- Amortize concurrent content-v2 repair commits with bounded, partition-safe
  semantic transaction batches.
- Use conditional S3-compatible PUT as the immutable-object existence probe,
  removing one network round trip for every newly relocated asset while
  retaining post-write checksum verification and idempotent conflict handling.

## 0.60.12 — 2026-08-15

### Fixed

- Concurrent content-v2 workers now partition and lock by logical tool execution
  identity instead of whole thread. Independent calls in very large legacy
  threads can repair in parallel while reused call identities remain ordered on
  one worker.

## 0.60.11 — 2026-08-15

### Fixed

- Content-v2 apply now builds migration-scoped partial indexes for execution,
  participant, and migrated-event identity lookups instead of repeatedly
  scanning JSON history for every repaired message.
- Prepared asset nodes and ownership edges are inserted in bounded sets,
  reducing the number of database round trips in the semantic repair path.
- Participants synthesized by content-v2 now use the canonical external-ID
  source identity.

## 0.60.10 — 2026-08-15

### Fixed

- Content-v2 apply now builds a temporary partial candidate index before
  semantic repair, eliminating a full candidate sort and PostgreSQL temporary
  spill for every repaired message.
- Concurrent semantic workers use stable thread-hash partitions, keeping every
  thread on one worker while avoiding idle workers contending for adjacent
  messages from the same thread.
- Successful semantic repair removes the temporary index; interrupted runs
  retain it so a resumable rerun can reuse the completed index build.

## 0.60.9 — 2026-08-15

### Changed

- Content-v2 apply can now run independent semantic repairs concurrently with
  bounded `semanticConcurrency`, using `FOR UPDATE SKIP LOCKED` claims and
  transaction-scoped per-thread advisory locks.
- Concurrent repair keeps strict preflight, per-message resumability, thread
  ordering, and bounded progress telemetry while eliminating the sequential N+1
  latency multiplier on remote PostgreSQL databases.

## 0.60.8 — 2026-08-15

### Fixed

- Content-v2 dry-run and ambiguity preflight now use keyset-paginated semantic
  planning, releasing legacy payloads between batches so memory use is bounded
  by `semanticBatchSize` instead of total tenant history.
- Large legacy payload sets no longer exhaust the JavaScript heap while
  retaining read-only planning, deterministic ordering, and strict ambiguity
  rejection.

## 0.60.7 — 2026-08-15

### Changed

- Content-v2 dry-run is now a read-only bulk planner with a bounded number of
  SQL round trips instead of applying every repair inside a rollback-only
  transaction.
- Apply preflights ambiguous history before writes, commits semantic repair in
  resumable bounded batches, and exposes semantic, asset, and byte progress.

### Fixed

- Large content-v2 dry-runs no longer generate production-sized writes, WAL,
  MVCC churn, or multi-hour open transactions merely to calculate a report.

## 0.60.5 — 2026-08-14

### Fixed

- Content-v2 now audits existing tool outputs in indexed batches, resolves
  provenance once per batch, uploads bodies with bounded concurrency, and
  commits each relocated batch in one database update instead of performing
  history-sized N+1 queries and per-asset transactions.

## 0.60.4 — 2026-08-14

### Fixed

- Content-v2 now uses explicit legacy execution IDs, projected-output and error
  digests, and original result creation times to disambiguate reused tool calls.

## 0.60.3 — 2026-08-14

### Fixed

- Existing delivery settlement-scope backfills now recurse only from delivery
  obligations that need migration, avoiding history-sized temporary results.

## 0.60.2 — 2026-08-14

### Added

- Delivery-level settlement scopes with declarative detached durable processors,
  automatic descendant propagation, scope-local cancellation, and Worker-output
  settlement.

### Changed

- Long-term memory consolidation now runs as durable background work without
  blocking or failing the user-facing run.

## 0.60.1 — 2026-08-14

### Fixed

- Content-v2 now disambiguates reused legacy tool-call IDs with canonical
  output/argument digests, participant/message evidence, and causal timestamps
  before refusing an uncertain match.

## 0.60.0 — 2026-08-14

This release separates graph asset metadata from pluggable body storage and
repairs legacy tool-result history.

### Added

- Declarative database, memory, filesystem-capability, S3-compatible, and
  injected asset body storage with immutable provenance paths and mixed-location
  reads.
- Generic nested data-URL extraction for tool results before live output,
  persistence, and model continuation.
- The isolated `migration/content-v2` dry-run/apply workflow for canonicalizing
  legacy tool messages and relocating database bodies to object storage.

### Changed

- Database storage remains the zero-configuration default and now accepts up to
  8 MiB per asset.
- The v1 upgrader classifies tool-authored messages as tool executions instead
  of public conversation and skips their duplicate legacy message events.
- HTTP asset metadata omits physical body locations.

## 0.59.26 — 2026-08-14

### Fixed

- The explicit memory-v4 migration now reads legacy memory records and
  checkpoints in bounded batches instead of retaining every embedding and ID in
  application memory.
- Legacy memory relations are rewritten with database-side endpoint detection,
  preserving relation typing when connected records cross migration batches.

## 0.59.25 — 2026-08-14

This release replaces the mixed memory model with a queryable semantic memory
ontology and keeps embedded applications available across recoverable database
connection failures.

### Added

- Memory records use explicit semantic forms, lifecycle states, temporal scope,
  provenance, epistemic metadata, and typed relations for agent and user query.
- Consolidation is an ordinary guarded tool flow, with plugin-provided context
  contributors and post-response similarity retrieval.
- An isolated, idempotent memory-v4 migration preserves legacy records,
  continuity, provenance, history, and relations.
- `createCopilotzPersistence()` lets co-located Gateway, Worker, and application
  services share one stable reconnectable database facade without exposing the
  private SQL session abstraction or transferring ownership to a role.

### Fixed

- Reconnectable persistence now classifies connection failures, serializes
  recovery, fences stale generations, bounds request admission, terminates
  indeterminate live work, and recovers durable deliveries after reconnection.
- Gateway persistence outages return retryable HTTP 503 responses with
  `Retry-After` instead of leaving requests hanging or requiring process
  replacement.

## 0.59.24 — 2026-08-13

This patch aligns the framework and frontend package releases after preserving
participant identity through parallel stream settlement.

### Fixed

- The coordinated frontend adapter retains each LLM attempt's agent identity
  when its terminal durable message arrives without repeating the agent payload,
  keeping parallel participant answers visually stable through settlement.

## 0.59.23 — 2026-08-13

This patch keeps durable workflow identities safe across deeply nested tool,
pipeline, ask, and realtime continuations.

### Fixed

- Synthesized workflow IDs preserve their readable form while short, then
  compact deterministically with SHA-256 before recursive ancestry can exceed
  downstream transport limits.
- LLM attempts, agent messages, tool executions, pipeline stages, public asks,
  and realtime tool calls now share the same runtime-neutral identity rule.

## 0.59.22 — 2026-08-13

This patch makes uploaded and tool-produced files addressable across the full
agent, tool, persistence, and client flow.

### Added

- LLM transcript attachments carry model-visible raw and tenant-qualified asset
  references while retaining provider-native multimodal parts.
- Workflow tools can return bounded output plus canonical attachments through
  `WorkflowToolResult`.
- OpenAPI resources can map tool response fields into canonical attachments
  through `API.responseAssets`.

### Fixed

- Asset-aware tools resolve raw IDs, canonical `asset://namespace/id` refs, and
  the legacy unqualified shorthand through one namespace-safe parser.
- Binary export bodies are removed from live/model output and persisted once as
  immutable content referenced by the public tool-result message.

## 0.59.21 — 2026-08-13

This patch lets downstream applications type their own processors against the
real delivery contract instead of duck-typing it.

### Added

- `@copilotz/copilotz/engine` exposes the processor-facing context types,
  including `CopilotzProcessorContext` and `CopilotzLiveProcessorContext`.
  Previously these were reachable only through the root barrel, which forces
  applications that ban barrel imports to redeclare the context structurally.
  Engine assembly itself stays internal to `@copilotz/copilotz/application`, so
  the new subpath is types only.

## 0.59.20 — 2026-08-13

This patch makes tenant schema lifecycle explicit and exposes renderable history
without flattening the event-native domain contract.

### Added

- `validateCopilotzSchema()` performs a read-only structural check of every
  runtime-required column in the four-table baseline.
- `provisionCopilotzSchema()` is the explicit schema create/upgrade lifecycle
  for migrations and tenant onboarding.
- Message history accepts `include=content,workflow` and returns canonical
  messages with related LLM attempts, tool executions, and immutable content in
  one compound document.

### Fixed

- Lazy tenant access no longer reruns schema DDL or waits on trigger/index locks
  during ordinary requests.
- Co-located Gateway/Worker topologies can let one role provision the default
  schema while the other validates it.
- Canonical history retains participant identity, reasoning, tool calls,
  execution state, projected output, errors, attachments, and pagination without
  introducing a flattened compatibility model.

## 0.59.19 — 2026-08-13

This patch makes tool execution lifecycle and progressive output first-class in
the event-native channel contract.

### Added

- Tools can emit ordered `tool_output.delta` events on named channels such as
  `stdout`, `stderr`, and `result` while they execute.
- OpenAPI tools can consume `application/x-ndjson` responses incrementally,
  preserving backpressure from an HTTP workload through the Copilotz event
  stream.
- Small ordinary tool return values are projected automatically onto the live
  `result` channel without duplicating explicit output.

### Fixed

- Tool lifecycle events now carry stable call, execution, tool, status, and
  bounded error fields with the tool's configured visibility policy.
- The canonical `/channels/*` routes retain native event names and payloads;
  uppercase compatibility projection remains isolated to legacy `/providers/*`
  routes.

## 0.59.18 — 2026-08-12

This patch restores legacy v1 thread-history queries over the event-native
conversation API.

### Fixed

- The v1 Fetch adapter treats the legacy `status=all` thread-list query as no
  status filter instead of looking for a literal `all` thread status.
- Explicit status filters such as `active`, `archived`, and custom statuses
  continue to pass through unchanged.

## 0.59.17 — 2026-08-12

This patch makes periodic event retention safe for large PostgreSQL schemas.

### Fixed

- Event and settled-delivery compaction runs in bounded batches instead of one
  unbounded delete transaction.
- Candidate selection uses existing position and namespace/causation indexes;
  causal trees are compacted safely from their leaves without rollout DDL.
- The existing maintenance `limit` now bounds recovery and each compaction
  phase, with a defensive maximum of 1,000 rows per phase.
- Ominipg `0.9.0-rc.10` and Oxian `0.21.0-rc.4` keep timed-out database sessions
  recoverable and expose bounded HTTP worker capacity downstream.

## 0.59.16 — 2026-08-12

This patch bounds one-way migration responses for legacy LLM attempts with very
large embedded transcripts.

### Fixed

- Legacy LLM attempts are migrated in single-row pages so multi-gigabyte
  histories cannot overflow Ominipg's session-frame encoding.
- Ordinary node types retain their larger migration batches.

## 0.59.15 — 2026-08-12

This patch makes the one-way v1 database upgrade preserve legacy text-labelled
assets whose bytes are not valid UTF-8.

### Fixed

- Invalidly labelled legacy `text/*` assets are stored losslessly as base64
  while retaining their media type; valid UTF-8 text and JSON remain unchanged.
- Runtime asset writes remain strict, so this compatibility behavior is limited
  to importing historical data.

## 0.59.14 — 2026-08-12

This patch adopts Oxian `0.21.0-rc.3` and Ominipg `0.9.0-rc.9` so embedded
Copilotz runtimes can keep durable in-process streams alive for the application
lifetime.

### Fixed

- In-process Gateway, Worker, database-session, and realtime streams no longer
  inherit WebSocket connection-age rotation or its bounded drain timeout.
- WebSocket Workers retain proactive connection rotation and the existing
  reconnect lifecycle.

## 0.59.13 — 2026-08-12

This patch preserves historical workflows whose legacy conversation threads were
deleted before the one-way v1 upgrade.

### Fixed

- Legacy tool executions and LLM attempts with an unavailable thread now share
  an archived tombstone thread for that original thread ID instead of aborting
  the tenant transaction.
- Workflow and tombstone metadata explicitly records orphan recovery, and
  settled event references continue to resolve without attaching history to an
  unrelated live conversation.

## 0.59.12 — 2026-08-12

This patch adopts Ominipg `0.9.0-rc.8` and exposes its configurable session
request timeout through managed Copilotz persistence.

### Fixed

- Long-running migration and analytical queries can opt into a request timeout
  above Ominipg's unchanged 30-second default.

## 0.59.11 — 2026-08-11

This patch completes the legacy null-content migration fix without losing
available partial model output.

### Fixed

- Legacy LLM attempts still prefer `partialAnswer` or `partialReasoning` when a
  final field is null; JSON `null` is preserved only when no partial fallback
  exists.

## 0.59.10 — 2026-08-11

This patch preserves explicit null output fields during the one-way v1
migration.

### Fixed

- Legacy LLM attempts with an explicit `null` answer or reasoning value and no
  partial fallback now materialize that value as valid JSON `null` instead of
  producing an empty JSON asset and aborting the tenant transaction.

## 0.59.9 — 2026-08-11

This patch aligns durable tool-execution identity with provider behavior found
in long-lived production threads.

### Fixed

- Provider tool-call IDs are indexed as repeatable lookup labels instead of
  being treated as globally unique within a thread. Durable node/event IDs
  remain the canonical execution identity.
- Re-provisioning an existing v3 schema removes the obsolete unique tool-call
  index, and the v1 migration preserves every historical execution when a
  provider reuses a call ID across attempts.
- Singular tool-call lookup now deterministically returns the latest matching
  execution; exact callers continue to address executions by their canonical ID.

## 0.59.8 — 2026-08-11

This patch adopts Ominipg `0.9.0-rc.7` throughout Copilotz.

### Fixed

- Large database request and response frames now cross Oxian as bounded,
  backpressured stream chunks instead of exceeding the worker staging limit.
- Downstream applications resolve one consistent Ominipg release rather than
  retaining the previous transitive version alongside a direct upgrade.

## 0.59.7 — 2026-08-11

This patch reconciles a legacy message's logical scope with its canonical thread
during the one-way v1 upgrade.

### Fixed

- A message whose legacy namespace differs from its readable thread now adopts
  the thread namespace atomically instead of aborting the tenant migration.
- Outgoing edge scope follows the moved message, and migration metadata retains
  the original namespace for auditability.

## 0.59.6 — 2026-08-11

This patch makes bounded v1 node pagination safe with PostgreSQL timestamp
decoding.

### Fixed

- Migration cursors now round-trip the database's exact `timestamptz` text,
  preserving microseconds instead of re-reading the final page after a driver
  converts timestamps to millisecond-precision JavaScript dates.
- The bounded-batch regression test emulates PostgreSQL timestamp decoding with
  microsecond-distinct rows and fails fast if a cursor stops advancing.

## 0.59.5 — 2026-08-11

This patch preserves unavailable legacy JSON assets without inventing invalid
database bodies.

### Fixed

- Missing legacy `application/json` bodies use a valid `null` sentinel whose
  bytes, length, and digest agree while the asset remains explicitly failed and
  unreadable.

## 0.59.4 — 2026-08-11

This patch makes the one-way v1 database upgrade safe for large production
tenant histories.

### Fixed

- Multi-gigabyte upgrades translate events with one set-based database operation
  and normalize nodes in bounded keyset batches instead of loading whole tenant
  histories into application memory.
- Bulk graph and event copies return aggregate counts instead of materializing
  every inserted identifier in the migration process.

## 0.59.3 — 2026-08-11

This patch makes the v1 content migration loss-aware for production databases
whose historical filesystem assets are only partially available.

### Fixed

- Legacy message attachments become ordered canonical content references while
  retaining compatibility metadata.
- Asset resolvers can explicitly preserve unavailable bodies as `failed` or
  `abandoned` records; unexpected resolver failures still roll back the tenant.
- Failed legacy assets remain addressable and report not-ready reads instead of
  receiving invented empty content or blocking unrelated tenant migration.

## 0.59.2 — 2026-08-11

This patch restores graph-native conversation details required by embedded and
HTTP clients while keeping the event-native contracts authoritative.

### Fixed

- Thread names and descriptions are preserved by create, update, channel
  ingress, and the isolated v1 database upgrade.
- Channel thread participants are now independent from per-message recipients,
  so passive participants do not accidentally receive work.
- Thread participant filters accept either the internal participant ID or its
  stable external ID.
- Message history supports `before` cursors and ascending or descending order,
  enabling latest-first windows and chronological client pages without offset
  pagination.
- Tool-call-only LLM turns now create their public agent-message anchor instead
  of disappearing from durable conversation history.
- The v1 Fetch projection emits explicit SSE `event:` names, restoring the
  uppercase stream contract expected by existing clients.

## 0.59.0 — 2026-08-11

This pre-1.0 minor makes shared persistence and physical-schema routing
first-class without multiplying Copilotz execution infrastructure.

### Added

- Application-owned Ominipg database injection through the public `database`
  option. Copilotz adapts the database internally and never closes an injected
  instance.
- Lazy `databaseScope(name)` application views and per-operation
  `databaseSchema` routing. Every schema gets isolated repositories and event
  observation while sharing one database, Gateway/Worker topology, and Oxian
  executor.
- Trusted `resolveDatabaseSchema(request)` Gateway routing for multi-tenant HTTP
  applications. Untrusted request context can confirm, but cannot choose, a
  physical schema.
- Atomic named collection commands through `defineCollection({ commands })` and
  `POST /collections/:name/:id/commands/:command`. Commands lock the aggregate,
  validate the resulting record, emit one semantic event, and honor idempotency
  keys.
- Feature response headers across JSON, empty, and streaming Fetch responses.

### Changed

- Ominipg advances to `0.9.0-rc.6`, whose operation lane makes one shared
  database instance safe across Gateway and Worker transaction boundaries.
- Delivery, live-event, and realtime workload metadata now carry the physical
  database schema so detached Workers resolve the correct durable scope.
- Goal, channel, attachment, recovery, and maintenance capabilities resolve
  against the same lazy schema boundary.

### Removed

- The public SQL-session injection vocabulary, `closeSession`, and managed
  session factories. SQL sessions remain a package-private persistence seam;
  applications configure or inject a database.

## 0.58.0 — 2026-08-10

This pre-1.0 minor release makes Copilotz topology explicit while keeping the
ordinary embedded application simple.

### Added

- `createCopilotzGateway()` for durable ingress, HTTP Fetch handling, recovery,
  event relay, and Oxian placement without hosting plugin execution.
- `createCopilotzWorker()` for outbound in-process or WebSocket Workers that
  reconstruct plugin executors locally.
- One versioned framed Worker-output protocol for semantic events, response
  metadata, raw bytes, cancellation, and completion across both transport types.
- Runtime-neutral `gateway.fetch` and capability-oriented `listen(gateway)` on
  the Deno adapter.
- In-process and real-WebSocket contracts covering cascading durable work,
  ephemeral output, realtime stream bytes, frame non-persistence, injected
  infrastructure ownership, and capacity-one Workers.

### Changed

- `createCopilotz()` now composes a private Gateway and Worker over an
  in-process Oxian event fabric while exposing only application semantics.
- Detached Worker events return to the Gateway immediately; their durable
  delivery obligations are placed there while Ominipg remains the recovery
  authority.
- Causal completion waits for correlated output relays before its final database
  confirmation, eliminating the final-frame/settlement race.
- Run contracts now use the direct `RunInput` and `RunHandle` vocabulary instead
  of event-native-prefixed aliases.
- Gateway, Worker, and embedded products remain frozen factory records with
  closure-held state and explicit infrastructure ownership.

### Removed

- Public engine/application assembly factories and raw workload maps. Engine,
  delivery-executor, and framed-protocol composition are package-private.
- `application.engine`, `application.execution`, and embedded Hypervisor or
  transport leakage.
- Public event-native server assembly; v3 HTTP is `gateway.fetch`, while the
  `/server` subpath retains only the transitional v1 projection.
- The `/engine` and `/execution` package entry points.

## 0.57.0 — 2026-08-08

Copilotz v3 is an intentionally breaking pre-1.0 architecture release.

### Added

- Factory-created applications, engines, plugins, processors, resources, and
  runtime adapters.
- Canonical immutable content/assets shared by messages, tools, model attempts,
  knowledge, memory, and finalized media.
- Immutable positioned semantic events plus sparse, durable consumer deliveries
  with leases, retries, dead letters, causal settlement, recovery, and
  compaction.
- Oxian execution with private in-process, injected shared-hypervisor, and
  remote dispatcher placement.
- Graph-native participants, threads, messages, model attempts, tool executions,
  custom collections, relations, schedules, memory, usage, and knowledge.
- Public same-thread agent `ask`, persistent attachments, one-call Web Stream
  ingress, participant-labelled concurrent outputs, and realtime provider
  capabilities.
- Runtime-neutral core and explicit Deno, Node, MCP stdio, server, filesystem,
  terminal, and package-loader adapters.
- Agent Skills-compatible manifests, portable lazy skill resources, optional
  plugin-owned disclosure tools, and a Deno build-time directory packer.
- Explicit least-authority agent capabilities, derived ask/skill mechanisms, and
  canonical application introspection with plugin origins.
- Worker-local Oxian workload maps for embedded or outbound registration.
- An isolated one-way v1 database upgrade and transitional v1 HTTP/SSE boundary.

### Changed

- Package composition now uses validated plugins and stable resource IDs.
- `run()` is a temporary attachment over one causal scope; `connect()` owns
  persistent text/control/media interaction.
- Collection post-write behavior is expressed as independent named processors.
- Ominipg is the durable state/recovery authority; Oxian owns work placement.
- Copilotz now targets Oxian `0.21.0-rc.2`'s shared event-fabric lifecycle and
  Ominipg `0.9.0-rc.5`. Embedded Hypervisors and Workers share an explicit
  transport record; Workers auto-start and expose `ready` / `closed` promises.
- Standard Agent Skills directories are canonical source while generated plugin
  modules are runtime artifacts; generic applications install no skills by
  default.
- Runtime-specific adapter subpaths expose capability-oriented factory names;
  host names no longer repeat in their public symbols.
- Workspace and process adapter plugins use runtime-independent logical IDs,
  allowing equivalent host implementations to replace them by capability.
- The interactive CLI coalesces one streamed tool-call draft into one labelled
  tool line while preserving argument deltas for other event consumers.
- Provider and text workflows are the only default core plugins; tools, web,
  finance, memory, usage, ask, schedules, knowledge, and skills are opt-ins.
- The interactive CLI reads agents, tools, and skills from application
  introspection instead of accepting disconnected display arrays.
- The package advances from 0.56.x to 0.57.0 while adopting the v3 public API
  and architecture.

### Removed

- The queue worker/scheduler architecture, thread leases, run generations,
  supersession/coalescing, processor claiming/swallowing/priority phases, and
  legacy resource filesystem loader.
- Private agent delegation/consultation, post-write hooks, public raw graph
  mutation APIs, dual thread storage, compatibility aliases, and stateful
  service-class assembly.
- Unconditional host-runtime imports from the core.
- The statically imported Copilotz development-skill catalog, generated
  per-skill data modules, core skill tools, and injected filesystem reader.
- Agent `allowed*` fields, implicit all-resource inheritance, and static CLI
  agent/tool metadata.

See
[the v3 migration guide](https://github.com/copilotzhq/copilotz/blob/4a3c0b55ed857919757cc077ccbf479277d6eca8/docs/migration-v3.md)
and
[downstream migration matrix](https://github.com/copilotzhq/copilotz/blob/4a3c0b55ed857919757cc077ccbf479277d6eca8/docs/v3/downstream-migration.md).
