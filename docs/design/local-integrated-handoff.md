# Integrated implementation handoff — 18 October 2026

## Direction and deadline

User requests completing the entire owner-based refactor, then the two-agent
acceptance project, then Compass including its frontend, targeting the end of 18
October in UTC−03. Implement remaining library work in one integrated pass. Use
build/type/artifact checks during implementation and the real acceptance project
for end-to-end validation. Stop per-slice unit/review cycles; preserve existing
tests and failure evidence for the eventual release gate. Deliver runnable
checkpoints for direct user review. Do not silently drop requirements not
exercised by the simple app.

Continue on the user's Mac after this checkpoint. Preserve all existing dirty
checkouts and unpushed work using separate worktrees. No merge, publish,
production deployment or production migration is authorized.

## Repository cohort

- Copilotz draft PR93: `feat/view-primitive`. The preceding remote checkpoint is
  `a17e8ab159ca3fd36be6276b3c88296556dbf97c`, tree
  `e15299992cb4ed1b5f5d0dafe32d5e44a135cecb`. This handoff commit includes a
  newer integrated WIP. Use the exact branch head supplied with the transfer.
- Oxian draft PR28, `feat/worker-host-calls`:
  `b840444d548653a77249c92ee7a73bad8961d2a1`, tree
  `dcae1bc6bdbc3a54725561818572fce21fe56836`
- Ominipg draft PR4, `fix/postgres-savepoint-pinning`:
  `6ac94e8a1cffa65f09f8c90b6eeced28e76b9eb7`, tree
  `88842ae5b249be45d03c888eef88efbc1a3846aa`
- Published dependency pins have not changed. Actual reverse-call tests require
  the Oxian sibling source; PostgreSQL savepoint tests require the Ominipg
  sibling.
- Compass is private `copilotzhq/compass`; last inspected main was
  `6b0fa6fde2f444e40a6d376d2eb8211e8b07d547`. It was inspected read-only, not
  migrated. Do not copy its private code into the public Copilotz PR.

## Local continuation — 18 October 2026

The isolated Mac worktree started from Copilotz
`16ed57672cf16a1721983630bb679dfddc75e720`, tree
`017d3909e7ad6eebac90cba0776611a77acff9c2`, with the exact sibling revisions
above. Original local worktrees and unpushed work remain untouched.

The LLM now prepares final reference and Asset semantics before closing writers.
It forwards a sealed pending pointer only when the final normalized media type,
length and digest match; unmatched streams remain observations. The generated
content, reasoning and native-reasoning output types accept pending pointers,
while hydrated history stays Asset-only. NDJSON also preserves pending outputs.
Omitted stream kinds use one shared media-type mapping, and equivalent reordered
descriptor keys have the same close replay identity. A preparation failure drains
writers which have not yet reached close.

Validation: all 46 public exports type-check against the exact local sibling
sources using:

```sh
node scripts/check-owner-cohort.mjs --oxian-source ../oxian-js --ominipg-source ../ominipg
```

The diagnostic uses an explicit standalone import map, verifies the public root
graph contains both sibling sources and no published Oxian/Ominipg modules, then
checks every public entry. An external `--config` alone was insufficient because
nested package manifests restored published dependencies. Published package pins
are unchanged. Plugin boundaries, forbidden-symbol checks and whitespace checks
pass. No unit suite or acceptance app was run for this checkpoint.

This remains WIP: registered owner content capture/read capabilities, forwarding
through Message projection, atomic Collection adoption, recovery, public Node
hosting, full interactive Views, acceptance and Compass remain unfinished. The
legacy worker wrapper now declares only the Worker fields it actually exposes;
it does not implicitly acquire the new host-call API.

## Cloud handoff WIP, not accepted functionality

The preceding checkpoint added shared successful-content settlement predicates
and replay protection. Its scoped checks passed: 31 tests +46 schema steps, 3
seal-status cases and16 actual-host abort/disposal regressions. These are not
full-library/PostgreSQL acceptance.

This newer WIP adds:

- Separate final reference and Asset metadata envelope, captured at seal intent
- Owner stream `seal_descriptor`, copied into logical body on verified seal
- Completion/status comparison against captured final semantics
- Status request comparison of expected length/descriptor for close retries
- Real `close` port across owner host, local raw-call tracker and worker
  transport
- Writer close drains queued append work and forces the final checkpoint before
  seal; observation retention is supported after successful close
- Captured immutable JSON data without getter/iterator/toJSON execution

`deno check` of `runtime/application/owner-host.ts` passes on this checkpoint.
The public `index.ts` check fails at
`plugins/llm/actions/call-llm/index.ts:2207` because close now returns
`PreparedContent | PendingContentRef` and the legacy LLM consumer still requires
PreparedContent. This is the next integration, not a claimed green build. No
unit suite was run on this WIP. Existing tests using old stream-port fixtures or
flat descriptors need later migration.

Other concrete close follow-ups:

- Wire normalized final LLM semantics BEFORE `settleWriters`, and reuse pending
  bytes only when media type, length and digest exactly match final normalized
  output. Otherwise keep the stream observational and capture final bytes
  separately. No post-seal descriptor rewrite API.
- Preserve ContentRef metadata separately from Asset origin/metadata. NDJSON
  channel metadata is used in both places by the current caller.
- Current close uses local JSON string equality for repeated descriptor input;
  normalize key order if semantic-equivalent reordered input must replay.
- Complete lifecycle/reentrancy/cancellation behavior through E2E. In particular
  disposal, close and invocation drain must await actual physical calls.
- The writer currently defaults omitted kind to text; reconcile with owner open
  normalization before relying on omitted kind for non-text media.
- SQL descriptor limit is independent of wire JSON size. Canonical envelope is
  256 KiB; SQL JSONB rendering is bounded at1MiB. Numeric expansion can exceed
  the SQL bound and must refuse rather than truncate. Ordinary stream command
  limits remain64KiB; only seal/status have the larger bounded envelope.

## Immediate integrated implementation path

1. Finish LLM and NDJSON generated-output migration. Compact pending pointers
   are not persisted Asset references. Update LlmCallOutput's three lanes and
   forwarding through project-text-result/create-thread-message, while keeping
   hydrated input/history Asset-only.
2. Wire actual content capabilities in both registered invocation paths.
   `registered-action-invocation.ts` currently exposes unsupported content
   methods; Processor content is unsupported too. Pure preparation can reuse the
   existing ContentPreparer. Non-stream capture needs real owner physical
   capture, not fake published streams.
3. Atomic Message adoption through the existing Collection transaction/kernel.
   `owner/collections.ts` and `owner/transaction.ts` currently reject content
   collections. Extend the existing kernel seam, not a parallel mutation engine.
   Asset node, domain ownership edge and adoption receipt must commit together.
4. Logical-body readback, actual retained recovery, current-copy promotion and
   retirement, then remaining authority/recovery/public composition
   requirements.
5. Complete public live Views/client subscriptions and Node package/build/host
   path. Then run the separate acceptance project, followed by Compass
   migration.

Pending pointer possession and producer metadata do not authorize adoption.
Fresh adoption requires current consumer authority, exact durable producer
terminal/output and causal child-admission evidence. Same settlement scope is
insufficient because siblings share it. A logical adoption key identifies the
domain mutation and content slot; body/pointer belongs in its fingerprint.
Retirement/promotion/adoption preserve owner epoch fencing and operation→body
lock order. Current design supports one owner ID per SQL schema.

Do not replace logical content with standalone Assets before domain adoption,
copy bytes into event payloads, globally deduplicate ownership by digest, or
restore worker leases. Old physical ready/lease APIs remain legacy only.

## Full-stack and acceptance contract

Read `browser-worker-acceptance-plan.md` and `implementation-status.md` for the
complete approved backlog. Checklist currently105 tasks:72 checked,33 open;
acceptance app and Compass are subsequent work, not hidden in that count.

The separate project must be Node.js-based without a Deno consumer prerequisite.
Root folders: actions, adapters, collections, processors, views, resources. Two
real agents, built-in and custom tools. Local Node owner, all authored agent,
Action and Processor work in browser. All authored UI exclusively through Views.
One public createCopilotz, storage versus owner connection. No internal host
imports, test transport factories, or silent server execution fallback.

Views currently provide one-shot text; full interactive rendering and general
Collection subscriptions remain incomplete. Implement typed contexts, nested
Views, routing/resources, local form state, Actions in event handlers, committed
selection replay/reset, authorization changes and disposal. Keep the text
renderer. Do not build an independent React app with a few embedded Views.

The Node path needs npm-compatible exports/dependencies, native build and
HTTP/WebSocket hosting. A Deno-built bundle run under Node is not sufficient.

Compass migration must cover the four agents (North/South/East/West), Spaces,
Kanban, Docs, jobs, auth/tenant isolation, draft state, provider login,
integrations, computer/sandbox and frontend. Its main branch triggers Cloud Run
deployment; use a draft migration branch only. Current app/start.ts uses
gateway+worker; frontend is React19/Vite. Inspect current code before editing.
