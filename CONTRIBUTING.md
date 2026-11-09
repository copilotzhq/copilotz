# Contributing to Copilotz

This page is for working on Copilotz itself: the layout, the rules between its layers, the test
suite on 3 runtimes, the example app, and how a release goes out.

## Checking a change

From a clone of the repository:

```sh
deno task check                               # types, everywhere
deno task test                                # the suite (COPILOTZ_TEST_POSTGRES_URL adds PostgreSQL)
npm install && npm test                       # the same on Node 24 (the TypeScript as it is, not .tsx)
bun test --timeout 60000                      # and on Bun
npm run build                                 # the npm package, in dist/npm/
node scripts/npm/smoke.ts                     # …packed, installed in a new project, and used
deno publish --dry-run                        # the JSR package
```

CI also checks the format with `deno fmt --check`.

## The suite on 3 runtimes

Tests use `testing/mod.ts` instead of a runtime's own APIs: tests, temp files, a local server, child
processes, and serving a Hypervisor. So one suite runs on Deno, Node and Bun.

Front ends are `.tsx` (Ink, React). Deno and Bun run them as they are. Node runs them from the npm
package's JavaScript.

The test workflow, `.github/workflows/test.yml`, runs the suite on Deno, Node and Bun against
PostgreSQL with pgvector, and on Node on macOS and Windows. On Deno it also checks the format, the
types and the JSR package. On Node it also builds the npm package and smoke-tests it.

The workflow runs when the publish workflow calls it, before a release, and on demand. It doesn't
run on pushes or pull requests. So run what a change touches locally before merging it.

The models plugin has 2 suites of its own:

- `plugins/models/tests/providers.test.ts` checks each adapter against a local server speaking that
  provider's API.
- `plugins/models/tests/live.test.ts` runs against the real APIs when `COPILOTZ_LIVE=1` and the
  provider's key are set.

## The layout

```
runtime/        the engine and its ports (Store, Blobs, Exporter, Transport, Clock): define, owner,
                executor, ops, wire, collection, mongo, the in-memory store; its HTTP (fetch,
                routes, cookies, site, tickets, api for the REST API, rest and client for scripts);
                runtimes (the pool); tests/
stores/         where the runtime keeps things: the Store port's implementations (memory, sql/
                sqlite and postgres with a shared translation, the latency wrapper) and Blobs'
                (blobs/files, blobs/http, blobs/gcs); tests/ (conformance)
exporters/      where measurements go: the Exporter port's implementations (OTLP, Prometheus)
plugins/        the features, by theme
  models/       one plugin: llm, embeddings, transcription, image; shared/ (providers, model
                choice, models.dev catalog)
  agents/       chat, history, memory, team, skills, routines, tiers, openapi, webtools
  billing/      usage (the ledger), credits, stripe
  access/       spaces (members, reach, rules), identity, contacts, Google, email and dev sign-in,
                connected accounts, the directory of orgs
  compute/      computers: desks per space, agents' tools, approvals; program/, the computer
                program; cloud, the computers the app hosts; apps, the apps agents publish
  work/         boards (kanban) and documents (versioned Markdown), with their front ends
  interfaces/   terminal (where each person is, the shell View), web (the web shell, site chats),
                the developer API, WhatsApp, voice (phone calls), MCP and maintenance; features'
                own front ends live with them (chat/terminal.ts, chat/web.tsx…), gathered by theme
hosts/          the places the app is used in: terminal (the Ink host and its toolkit); web (the
                React host in the browser: theme/, the tokens and their defaults, Copilotz's look
                and logo, and its fonts and icon, as data the server serves; toolkit/, the
                components; the sign-in page; its server half, the page as a plugin and the app's
                assets; and node/, listening and bundling on Node)
testing/        one test API for Deno, Node and Bun; the layers' import rules (boundaries.test.ts);
                plugins' CSS keeps to the theme (styles.test.ts)
design/         agreed designs
docs/           the guides, Build Compass, operations; manifest.json, which the website reads
scripts/        catalog.ts (refreshes the models.dev snapshot); npm/ (builds the npm package, and
                smoke-tests it installed); computer/ (builds the computer program); cloud/ (sets up
                Google Cloud for cloud computers); docs-index.py (docs/manifest.json)
examples/       terminal-agent (an app: its plugins and resources, run in the terminal host, or in a
                browser: web.ts serves it on Deno, harbor.tsx and brands.ts the same app as another
                brand, gallery.tsx the logo, type and toolkit, orgs.ts many orgs on Postgres);
                web-node (a web app on Node, routes.ts an app of routes alone, and orgs.ts, many
                orgs behind one address)
```

## The layers' import rules

Each layer imports only what it may. `testing/boundaries.test.ts` fails otherwise.

- The runtime imports nothing outside it.
- Stores, exporters and hosts import the runtime.
- A plugin imports the runtime, the hosts' toolkits, its own files and other plugins' `contract.ts`.
  The web host's toolkit comes through `hosts/web/mod.ts` only, plus `hosts/web/words.ts`.
- Tests, examples and a theme's own `mod.ts` and `terminal.ts` compose the layers, so they may
  import anything.

A host runs the app in a place, such as the web or the terminal, and uses the runtime's public API
only. A shell is that place's root View (`web.shell`, `terminal.shell`), and it's a plugin. A
feature's front end there is its own Views and commands.

## How a plugin is laid out

Inside a theme, each plugin is laid out by primitive: `collections/`, `actions/`, `events/`,
`processors/`, `views/`, `resources/`, `adapters/`, `routes/`. There's one file per declaration, and
`shared/` holds what several use. Its `mod.ts` only assembles them.

Its front ends are its own (`web.tsx`, `terminal.ts`), loaded only where they draw. The theme
gathers them, as `plugins/agents/web.tsx` does.

Tests sit next to their theme, in `plugins/<theme>/tests/`.

A plugin reaches another only through the runtime, by name. A plugin that builds on another says so
(`requires: ["chat"]`), and imports only its `contract.ts`: the shapes of its documents and resource
kinds, its Actions' inputs and outputs, and declaration helpers such as chat's `tool()`. Never its
code. Plugins that would share code are one plugin, as `models` is.

Plugins' CSS is only layout, on the theme's variables. `testing/styles.test.ts` fails otherwise.

The style is factories and plain data, with no classes.

## The example app

`examples/terminal-agent` is an app on all of it: an assistant and a researcher, notes in spaces,
and computers, in the terminal or in a browser.

```sh
deno task chat                                # fake model, in-memory store
deno task chat --screen                       # the whole screen; same Views
OPENAI_API_KEY=… deno task chat               # real model (MODEL=… to pick one)
deno task chat --rtt=1.74                     # simulate production DB round trips (ms)
deno task chat --sqlite                       # persist to .data/copilotz.sqlite (or --sqlite=path)
deno task chat --postgres=postgres://…        # persist to PostgreSQL (schema "copilotz")
deno task chat --executors=4                  # more executors in this process

deno task chat --listen=8787 --executors=0    # owner only; executors connect remotely…
deno task executor --port=8787                # …from other terminals (as many as you like)

deno task bench [--rtt=1.74] [--remote] [--sqlite | --postgres=URL]   # overhead per turn

deno task web [--sqlite]                      # the same app in a browser: http://localhost:8790
BRAND=harbor deno task web                    # …rebranded by one theme resource (/gallery: the toolkit)
EMAIL=1 deno task web                         # …with email sign-in, its messages in the terminal
node examples/web-node/server.ts              # a web app on Node: http://localhost:8080
node examples/web-node/orgs.ts                # many orgs behind one address, on Node
```

### In the terminal

You are a person to the runtime: `--as=ana`, and `/as bob` hands the terminal to someone else. Your
conversations live in your Personal space.

- `/space <name>` makes a shared space, and new conversations go there.
- `/invite <email> [role]` invites someone. `/invite agent:researcher viewer` lets an agent in at
  once.
- `/spaces` and `/work <n>` move between spaces.
- `/agents` lists who works in a space, with ● on the one that answers new chats.
- `/agent Maya: writes launch copy` makes an agent there, `@maya`. `/default maya` has it answer new
  chats, and `/remove agent:maya` takes it out.
- People join by accepting an invitation: `/invitations`, then `/accept <n>`. `--as=bob@example.com`
  is a person with that email.
- `/file <path> [message]` sends a file.
- `/computer connect` in a space gives the command that connects a computer to it.
- `/approve once|thread|always|no` answers what agents wait on.

Inside the chat: `/new`, `/threads`, `/open <n>`, `/history`, `/memories`, `/usage [all]`,
`/metrics [name]`, `/prompt [agent]`, `/fork`, `/retry`, `/events [n]`, `/stats`, `/sql <query>` (a
SQL store) and `/quit`. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, metrics also go to that collector.

Every turn prints its time, its database round trips, the jobs sent to executors and the calls they
made back to the owner.

### In the browser

You sign in by name or email, on this machine only. With `GOOGLE_CLIENT_ID` set you can sign in with
Google. With `EMAIL=1` you sign in with an email and a password, and its codes and links are written
to the terminal. `EMAIL_INVITE=<address>` invites someone as it starts.

Where you are is the address (`/thread/<id>`, `?in=<space>`), so links, back and forward, and 2 tabs
work.

⌘K (Ctrl+K) opens the command palette. From it you go to any space, chat or agent, make a space, a
chat or an agent, and invite someone. You also move this chat (or a memory, a note, a computer) to
another space, and rename, archive or leave a space. Each comes from the plugin it belongs to.

The composer also records voice messages.

## Releasing

Releases are tags. A `v1.*` tag publishes that version to JSR and npm, once the suite passes on
every runtime.

1. **The release commit.** On a branch, one commit named "Release X.Y.Z" sets the version everywhere
   it's named:
   - `deno.json` and `package.json`;
   - `package-lock.json`, in its 2 places;
   - the computer program's version files: `plugins/compute/computers/program/version.ts`, the
     example in `plugins/compute/computers/resources/downloads.ts`, and
     `plugins/compute/tests/program-platform.test.ts`;
   - the README's Deno install line;
   - the `computerDownloads({ dir })` line in
     [docs/guides/installing-a-computer.md](docs/guides/installing-a-computer.md).

   In [CHANGELOG.md](CHANGELOG.md), the commit turns "## Unreleased" into the version's heading,
   `## X.Y.Z — YYYY-MM-DD`. The release notes are what's under it.
2. **A pull request** for the branch, merged with a squash merge.
3. **A lightweight tag** `vX.Y.Z` on the merge commit, pushed:

   ```sh
   git tag vX.Y.Z <merge-commit> && git push origin vX.Y.Z
   ```

The tag runs `.github/workflows/publish.yml`. It checks that the tag names the version `deno.json`,
`package.json` and the computer program say. It runs the test workflow. It makes the tag's GitHub
release with the computer program: built on a Mac, or the last release's binaries when the program
hasn't changed. Then it publishes to JSR (`@copilotz/copilotz`) and to npm (`copilotz`), both
through GitHub's OIDC, with no token.

A version with a pre-release part, such as `-rc.31`, goes to npm's `next` tag, so
`npm install copilotz` keeps the last stable one.

A release whose tests fail publishes nothing. It's fixed forward and tagged again.

## Designs

The decisions behind the pieces are in [design/](design/): Views and the web, access, memory, and
tenancy. Read the one a change touches before changing it.
