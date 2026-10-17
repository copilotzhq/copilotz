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
   scope. No global package override or repository-local link is created
4. Runs `runtime/owner/connected.integration.test.ts` with type checking, over
   in-process and Node WebSocket transports, then removes its temporary config
   on success, test failure, startup error or handled interruption. Child exit
   failures and termination remain nonzero. An uncatchable process kill can
   leave an ordinary OS temporary directory, never a changed dependency pin

Missing or invalid source is an error for this explicit command. It never turns
into a skipped success or falls back to another checkout. Ordinary repository
test runs still skip these two opt-in cases when no source is selected. Run the
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

These adjacent Node tests cover explicit selection, spaces and URL-sensitive
characters, manifest/export/source validation, scoped imports, unchanged pins,
child failures, termination and temporary-file cleanup. They also run under the
existing repository test runner without adding Deno APIs to the tooling.

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
