# Documentation contract

This contract covers application-developer documentation:
[`README.md`](README.md), the [`docs/`](docs/README.md) pages and
[`docs/manifest.json`](docs/manifest.json). The `docs/` tree ships in the
published package, so every page must describe only the current public surface.
Plugin source layout for library contributors is separate: it lives in
[`docs/plugin-layout.md`](docs/plugin-layout.md), [`REPO.md`](REPO.md) and
[`ARCHITECTURE.md`](ARCHITECTURE.md). Never tell application developers to
follow repository-internal layout or source paths.

## Index roles

Each index page has one job. Do not let a second page grow into a broad map.

- [`docs/README.md`](docs/README.md) is the only broad documentation map,
  organised by lifecycle.
- [`README.md`](README.md) introduces the package and repeats the two quickstart
  snippets.
- [`docs/quickstart.md`](docs/quickstart.md) is a short runnable path on each
  track. It shows the expected output and links to four or fewer next pages.
- [`docs/getting-started.md`](docs/getting-started.md) holds the guide
  introduction, track diagram, setup and path list.
  [`docs/getting-started/README.md`](docs/getting-started/README.md) is a
  directory entry only.
- Reference pages explain one subsystem each.
  [`docs/plugin-layout.md`](docs/plugin-layout.md) is listed under the
  manifest's Contributors section.

## Lifecycle parts and tracks

The Getting Started guide builds one Notes application across six parts. Paths
are `docs/getting-started/part-N-slug/NN-slug.md`:

| Part                        | Chapters | Purpose                                |
| --------------------------- | -------- | -------------------------------------- |
| `part-1-design-and-build`   | 01–05    | Events, state, Actions, Plugins        |
| `part-2-verify-and-recover` | 06–07    | In-memory tests, persistence, recovery |
| `part-3-add-agent-behavior` | 08–14    | Optional agent harness                 |
| `part-4-release-to-users`   | 15–18    | HTTP, tenants, channels, content       |
| `part-5-operate-and-scale`  | 19–21    | Schedules, usage, deployment           |
| `part-6-evolve-and-reuse`   | 22       | Generated plugins and evolution        |

Track **R** (runtime) never imports `@copilotz/copilotz/core`. Track **H**
(agent harness) is optional. The runtime-only path is 1–7, 15, 16, 18, 19, 21,
22, and the fastest route to a model reply is setup, then Chapter 8. Directly
under each chapter's H1, put one track line:
`> Part N — Title · Track: R|H[, optional] · Requires: … · Needs: …`. The
`Requires` list must match the chapter table in
[`docs/getting-started.md`](docs/getting-started.md). Optional branches are
named as optional in that line, in the manifest description and in the intro
diagram. Never write "if you did chapter X" instructions; a chapter's starting
state follows only from its `Requires` line.

In [`docs/manifest.json`](docs/manifest.json), the first section is titled
`Getting Started` and lists the introduction followed by the chapters, in order,
titled `Ch N: Title`. Chapter front matter uses `section: Getting Started` and
`order: N × 10`.

## Page structure

**Tutorials** use these H2 headings, exactly and in order: The pain · The
problem · The solution · Check it works · What this unlocks · Next steps.

**Reference pages** use: The pain · The problem · The solution · Reference
(optional) · What this unlocks · Next steps. Navigation indexes and this file
are exempt.

- **The pain** is something concrete that the reader's current application gets
  wrong or cannot do, not a feature description.
- **The problem** names the underlying constraint, for example durability,
  ownership, isolation or trust.
- **The solution** introduces exactly one main new idea, in steps titled
  `` ### Create `file` `` or `` ### Edit `file` ``.
- **Check it works** gives the command plus the expected event facts, operation
  status or a predicate. Never assert exact model prose.
- **What this unlocks** states what the reader can now build or inspect.
- **Next steps** links to the next chapter, then any optional branches and
  reference pages.

## Code in documentation

- **Complete files** include every import and can run as shown. Name the file
  and its role (see below) in the prose that creates it.
- **Edits** name the file, the declaration, and whether the code is inserted or
  replaces something. Three or more changes to the same file require its
  complete updated file. One narrow exception applies: when a capability chapter
  can follow independent optional branches and edits a shared module (such as
  `agent.ts`, `assistant.ts` or `chat.ts`) and a full replacement would discard
  contributions from earlier optional chapters, the chapter may instead give
  exact named edits. Each edit names the file and declaration and says whether
  it inserts or appends. The chapter says briefly why no complete file is shown,
  keeps every existing list, map and grant, and shows the resulting baseline
  lists. The reviewer checks the resulting composition on every supported path.
  Don't invent wrapper or marker modules to avoid this. All other complete-file
  rules stay the same.
- **Additive capability edits.** Adding a capability appends to existing plugin
  lists, resource maps and grants and preserves every earlier contribution;
  never tell the reader to "replace the list". A targeted configuration change
  or refactor may replace one specifically named whole entry (for example, a
  database URL), and says so.
- **Purpose comments** explain why each section, declaration, function and
  meaningful property exists, including schemas, capability grants,
  configuration properties, exposure rules and cleanup. Skip syntax-only filler.
  Comment each shell command. Use `jsonc` when JSON needs comments.
- **Prerequisites first.** Packages, host capabilities, credentials and sample
  servers appear before the code that depends on them. Credentials come from the
  host environment and are read only in host composition.
- **Entrypoints** take varying input from command-line arguments, call
  `close()`, and report failure or settlement explicitly.
- Processors read `event.data`. Code that calls Actions declares them in its
  ordinary expected context type, using `ActionCallers` where appropriate.
  Action IDs and Collection names are stable and explicit. Grants and server
  exposure are explicit and narrow.

## Sample module roles

Every sample file has exactly one role:

1. **Definition modules** declare Collections, Actions, Processors, Plugins,
   Agents and Tools. They perform no top-level I/O and read no `env`. Server
   factories accept database options as parameters and never choose a persistent
   path.
2. **Host composition modules** choose connections, credentials, databases and
   live integrations. Only these may run top-level `await` discovery, such as
   MCP.
3. **Entrypoints** run things: send events, start chats or servers, and print
   results.

For every test and every runtime-only file, the reviewer lists its transitive
**local** imports. These checks cover only the local sample graph, not the
internals of published library helpers.

- A runtime-only file must not reach `@copilotz/copilotz/core` (including
  `/core/server` and `/core/client`).
- A test must not reach any host composition module or entrypoint, and needs no
  credential, network, subprocess or persistent path. Tests compose their own
  focused boundary and omit `database` to use the private in-memory default.
- Focused tests may replace a specifically named whole entry. A model connection
  is replaced by a complete named entry, such as `{ adapter: "scripted" }` with
  a scripted LLM adapter. A reused Agent spreads its definition and replaces
  `capabilities` as a whole object, granting only the tools, agents and skills
  that the test registers.

## Public API and source validation

Imports must be `@copilotz/copilotz` or one of its subpaths listed under
`exports` in `deno.json`. Validate every signature, option and event type
against the current source, not against older docs or memory. Source paths
belong in review notes, never in user-facing instructions. Do not use removed
legacy APIs: `createXPlugin(options)` factories, marker plugins or separate
compiler APIs, `prepareMcp`, `defineInlineSkill` or `app.actions`. Do not use
unpublished testing modules (`runtime/testing` is excluded from publishing) or
invented test, evaluation or migration APIs. Compose with `definePlugin` and the
public declarative helpers, such as `defineTool`, `defineApi`, `await defineMcp`
and `defineSkill`, imported from their plugin entrypoints in the form their
current signatures accept.

## Versions and installs

- Installation examples use one caret range for the planned release (currently
  `^0.86.1`). All subpaths come from the same package version.
- Before release, recheck that range against the `version` in `deno.json` and
  the published registry. Never publish an example pinned ahead of an available
  release.
- Deno 2.9 delays newly published versions by 24 hours. Setup documents the
  package-specific `minimumDependencyAge` exception once; other pages link to
  it.
- Past release notes live under "Release history" in
  [`docs/upgrading.md`](docs/upgrading.md). Active pages describe only current
  behaviour.

## Sync pairs and anchors

- The runtime and agent snippets in [`docs/quickstart.md`](docs/quickstart.md)
  and [`README.md`](README.md) are identical copies. Change both in the same
  edit.
- [`docs/getting-started.md`](docs/getting-started.md) keeps
  `## Before you start`, `### Deno` and `### Node`, so the `#before-you-start`,
  `#deno` and `#node` anchors keep working.
- When a heading that other pages link to changes, update every inbound link.

## Assets, runtimes and data safety

- State Deno and Node commands, or name the limitation. Node examples list their
  extra packages (for example, a database implementation or HTTP adapter) before
  the code.
- Files read at runtime, such as Skill directories, MCP server scripts and
  `import.meta.url`-relative paths, must be deployed with the application.
  Bundling can change where `import.meta.url` resolves. Say so wherever an
  example depends on it.
- Keep build-host steps (plugin generation, Skill packing) out of deployment
  runtime entrypoints.
- Examples never delete data. To reset, point `database.url` at a new local
  directory (for example `file://./data-ch18`) or use `:memory:`, and state that
  this state is disposable. Never claim an automatic migration. Startup
  validates the schema; document only the contracts listed in
  [`docs/upgrading.md`](docs/upgrading.md).

## Writing and review process

Work one file at a time: a writer drafts the file, an independent reviewer
checks it, and the writer makes the requested revisions. The next file starts
only after the reviewer accepts the current one.

The reviewer verifies:

- Type-check every complete runnable artifact, for example `deno check app.ts`
  in a scratch project that uses the documented install.
- Run the meaningful deterministic fixtures: runtime flows, scripted-adapter
  harness tests and HTTP access tests. Provider-backed examples are labelled as
  requiring credentials. Verify their syntax and contracts without claiming a
  live model call.
- Run `deno fmt --check` on changed Markdown. Check relative links and anchors
  by hand against the final tree; no link-check task exists.
- Use only tasks that exist in [`deno.json`](deno.json). The existing main CI
  still runs the full suite (`deno task check`, `deno task test` and the runtime
  smokes) on every update to main, and those checks must pass before a release
  is tagged. Do not add duplicate CI, and avoid running additional copies of the
  whole suite during individual prose reviews.

## Review checklist

1. Headings are exact, there is one main idea, and the track line matches the
   tree.
2. Prerequisites come before the code that depends on them.
3. New files are complete. Edits name the file, the declaration and whether they
   insert or replace. Capability additions preserve earlier contributions; any
   whole-entry replacement is targeted and named. No conditional "if you did"
   instructions.
4. Comments state purpose for every meaningful declaration, property and
   command.
5. Imports are public exports. No forbidden APIs, and no Core in track R files.
6. Module roles are declared. The local import graphs pass the rules above.
   Tests are provider-free, and they replace only named whole entries to narrow
   grants and connections.
7. "Check it works" gives a command and expected facts or a predicate.
8. Data resets use only new disposable paths. No automatic migration is claimed.
9. Deno and Node both work, or the gap is named. Asset and `import.meta.url`
   caveats are stated.
10. Links and anchors resolve, the README and quickstart snippets match, and the
    version range has been rechecked.
11. Artifacts were type-checked and fixtures were run before the next file.
