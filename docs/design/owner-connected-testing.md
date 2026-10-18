# Reproducible owner sibling-source fixtures

The private owner integration fixture can exercise a deliberately selected Oxian
source checkout before reverse worker calls are available through Copilotz's
published dependency pin. This is source-fixture evidence, not an
installed-package test, public owner composition, or completion of the npm
sibling-workflow backlog.

## Run

Use Node 24 and the Deno test runtime used by this repository, available on
`PATH`. Select an existing Oxian checkout that contains reverse worker calls:

```sh
node scripts/test-owner-connected.mjs --oxian-source ../oxian-js
```

The explicit `--oxian-source` option takes precedence over
`COPILOTZ_OXIAN_SOURCE_ROOT`. The environment variable remains available for
existing callers:

```sh
COPILOTZ_OXIAN_SOURCE_ROOT=../oxian-js node scripts/test-owner-connected.mjs
```

Quote paths containing spaces. Relative source paths are resolved against the
invoking working directory; the Copilotz root is resolved from the script
location. The script can therefore be invoked from another directory. Use
`--deno /path/to/deno` if the test executable is not on `PATH`; this selects an
executable, not a shell command with additional arguments.

The runner:

1. Resolves the selected directory and checks the `@oxian/oxian-js` manifest,
   its `./hypervisor`, `./worker`, and `./adapters/node` export targets, and the
   reverse-call source prerequisite. Required files cannot resolve outside the
   selected checkout. The fixture imports those public export entries and
   exercises `callHost`; structural setup checks alone do not prove API behavior
2. Prints the resolved source path and, when its own Git metadata is readable,
   its HEAD, tree and dirty status. The Git top-level must equal the selected
   checkout: an archive nested in another repository never claims that enclosing
   repository's revision. Dirty checkouts are allowed for co-development; their
   uncommitted changes are not described by the printed commit/tree. Nothing is
   fetched, checked out, committed or reset
3. Generates a temporary configuration outside both checkouts. Copilotz's
   imports retain their existing published versions. Oxian's own imports,
   including its exact `ws` pin, apply only within the selected sibling source
   scope. Only the actual owner-worker wrapper and the owner-composition
   implementation/typing modules resolve their worker dependency to the selected
   public worker entry; legacy runtime workers retain their published
   dependency. No global package override or repository-local link is created
4. Runs these exact seventeen files (220 declared cases) serially with type
   checking, including in-process and Node WebSocket transports:
   - `runtime/owner/connected.integration.test.ts`
   - `runtime/owner/execution.connected.test.ts`
   - `runtime/owner/preparation.connected.test.ts`
   - `runtime/application/owner-host.test.ts`
   - `runtime/application/owner-host.local.test.ts`
   - `runtime/application/owner-host.processor.test.ts`
   - `runtime/application/owner-host-local-processor.integration.test.ts`
   - `runtime/application/owner-host.capacity.test.ts`
   - `runtime/application/owner-host.recovery.test.ts`
   - `runtime/application/owner-host.terminal-recovery.test.ts`
   - `runtime/application/owner-host.startup.test.ts`
   - `runtime/application/owner-host.preparation.test.ts`
   - `runtime/application/owner-host.preparation-restart.test.ts`
   - `plugins/channel-telegram/actions/send-text/transport.integration.test.ts`
   - `runtime/application/owner-composition.connected.test.ts`
   - `runtime/application/owner-composition.restart.test.ts`
   - `build/role-bundle.connected.test.ts`

   The selected source enables 172 opt-in cases; the other 48 cases are
   unconditional. The local-host file covers private fresh local Actions and
   their shared effect protocol and local named preparation, including Processor
   retry capture, original-source denial, unknown outcomes and raw-call drain.
   Its prepared transaction-acknowledgement holds block the owner command pump;
   raw SQL observations during those holds are not concurrent owner commands.
   The preparation-restart file covers closed prepared context over both
   transports. The terminal-recovery file covers private exact-target resume
   cleanup and real continuation/cancellation over both transports. The imported
   preparation fixture declares no cases of its own

   It then removes its temporary config on success, test failure, startup error
   or handled interruption. Child exit failures and termination remain nonzero.
   An uncatchable process kill can leave an ordinary OS temporary directory,
   never a changed dependency pin

Missing or invalid source is an error for this explicit command. It never turns
into a skipped success or falls back to another checkout. Ordinary repository
test runs still skip these opt-in cases when no source is selected. Run the
script, rather than setting the source variable on an otherwise unconfigured
test invocation, so the sibling dependency scope is present.

CI can use the same command with two explicitly checked-out repository paths.
The CI job owns its revision selection; this development tool deliberately does
not pin one source commit or depend on a developer's directory layout.

## Restore normal dependency resolution

There is no repository state to reset: manifests, lockfiles, dependency pins and
local package links are never changed. If the source variable was exported in a
shell/session, remove it before ordinary non-sibling tests. Invoking the CLI
option alone does not alter the parent environment.

## Tooling checks and evidence boundary

```sh
node --test scripts/test-owner-connected.test.ts
```

These eleven adjacent Node tests cover explicit selection, spaces and
URL-sensitive characters, manifest/export/source validation, the exact target
list, scoped imports, unchanged pins, child failures, termination and
temporary-file cleanup. They also run under the existing repository test runner
without adding Deno APIs to the tooling. Setup-test success does not establish
that any connected case ran; retain the actual selected-source run separately.

The connected fixture uses the shared owner transaction planner for registered
Collection writes over actual capacity-one reverse calls, on both transports. It
verifies real PGlite tables, commit-gated output, a real postcommit Processor,
authorized View projection, captured-text replay and receipts. Each attempt
reruns the planning callback; its cyclic object containing a function and Map
remains local, while only the ordered Collection plan reaches the owner. The
same key replays the durable outcome, and reversing the same operations under
that key fails with `owner_intent_conflict` without new effects. It does not
prove a production HTTP/Action adapter, PostgreSQL crash recovery,
published-package compatibility or complete authority coverage.

The npm build/pack/link/reset workflow, Copilotz npm migration, and remaining
test-layout debt retain their own acceptance gates. Do not replace a published
dependency pin with a local path in a committed manifest to make this fixture
run.

The registered execution fixture additionally exercises the database-free worker
wrapper and real owner Action lifecycle tables over both transports. It gates
readiness, claim and completion; rejects a stale authenticated parent; permits
only restricted completion after ctx revocation; and refuses automatic execution
after an ambiguous claim reply. Each assignment has a separate immutable parent
call port. The whole plugin registry is loaded, and its Action uses Resource,
Adapter and owner-backed Collection capabilities. Its postcommit Processor
observer still uses the legacy executor. This is not yet the public factory,
complete owner-only Processor parity or HTTP ingress. Per-job renewal is retired
by the owner-controlled attempt amendment; it is not a remaining gate.

The fresh-host cases compose actual registered Actions, Processors, child
Actions, Collection mutation and catalog settlement. They test
inherited/detached scopes, current policy revocation, durable retry/renewal
alarms and bounded saturation. The Telegram cases inject a local provider and
real transport disconnection around effect/terminal acknowledgement; they never
call a live provider. These cases preserve no-resend evidence and explicitly
retain the fresh-host recovery limitation. They do not establish restart
readiness, owner-local epoch-only placement, complete channel/content support or
released-package compatibility.

The fresh public composition and role-artifact fixtures use the same bounded
storage/owner API and root-authored multi-primitive plugin. The artifact is
checked before tree shaking and runs without persistence implementation imports.
The separate public restart fixture resumes actual ordinary Collection,
Processor and child Action history on both transports. This proves that bounded
composition, not arbitrary lost execution, content recovery or owner-local
epoch-only placement.

The separate host startup cases validate declared indexes, refuse invalid resume
configuration before SQL or transport creation, and keep readiness unpublished
after uncertain commits or unresolved obligations. Their bounded restart cases
execute pending work once and replay canonical terminals across a second
takeover on both transports. The lost-Action recovery cases verify that actual
fresh-host history cannot acquire an absent original execution contract during
takeover; they do not turn blocked execution into recoverable work. These are
explicitly bounded source fixtures, not general crash-recovery acceptance.

The named-preparation reverse-call cases exercise lifecycle capture, real child
execution, immutable replay and current input/result authorization gates on both
transports. Their occupied parent is test scaffolding; these cases alone do not
prove public owner-host preparation composition. The separate public host
preparation cases create ordinary source records through owner Collection
commands, capture View output once, and reuse a registered child through the
public factory on both transports. They also exercise generic fallback,
malformed configuration, current input/result/parent revocation, missing
registration, bounded nested capacity and registration/policy snapshotting. None
of the selected fixtures establishes published-package compatibility, complete
channel/content recovery, or the full retained-suite and release acceptance
gates.

The 152-case inventory includes nineteen Processor host cases, thirty-three
local Action host cases and two actual-boundary/helper caller-facing reply
cases. The added local-child rows exercise mixed placement, result reuse across
local Processor retries, current authority, raw-call shutdown and capacity
refusal. The older frozen full-acceptance checkpoint ran 122 cases; that
historical evidence does not claim a complete 152-case canonical run of the
newer tree.
