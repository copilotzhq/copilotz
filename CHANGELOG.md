## 1.0.0-rc.7 — 2026-10-30

- **Apps: what serves a preview serves the app.** A folder with no Dockerfile is built into an image
  made for it (no more buildpacks, which found nothing to build in a plain folder): the computer's
  system (Debian 12) with Node.js 24 and Python, the folder as it was sent, its dependencies
  installed again (npm, pnpm, yarn; `requirements.txt`) and its `build` script run, then its job's
  command behind a front that passes the platform's port on to the job's port on localhost,
  WebSockets included. A job bound to `127.0.0.1` (as previews allow) is served all the same; the
  job is given its own port as `PORT`. `AppHost.build` answers the port its image serves on. Without
  a Dockerfile, an app is published from its job (its command).

## 1.0.0-rc.6 — 2026-10-30

- **Computer program:** an app on another machine over plain `ws:` (an `http://` address that isn't
  localhost) fails at once, saying to use https, instead of waiting to connect forever: Oxian
  refuses plain `ws:` but to this machine.
- **Cloud pools:** a pool grown for a wake isn't shrunk while its VM boots. `pool.take` records what
  it waits for (`poolWant`), and `pool.tick` sizes each pool to its floor, the takes of the last 2
  minutes and the wakes still waiting. Before, the next minute's sizing set the pool back to its
  floor, deleting the VM a wake had grown it for before it connected.
- **Cloud computers:** `cloudComputer.sizes` also says whether the person asking may make one now
  (`create`, and `why` not: `admins`, `budget`), and the warm and view minutes; `cloud.may` says
  just that. The web's "Use a cloud computer" choice shows why it can't be picked, and the copy says
  the app's minutes.
- **Cloud computers shared into a space:** each computer's state is kept on it and its desks
  (`status`: `{ kind: "cloud", state, size }`, set with the new system Action `computer.mark`, as
  the cloud plugin sees it change), so the space's members see how anyone's is (asleep, waking,
  awake), not "offline".
- **Previews:** `preview.here` records carry their address (`url`); the web no longer works it out.
  `computer.preview` and `computer.scope` take a `desk` (one of the space's), and so does
  `app.publish`: the web makes previews and publishes apps from the computer it's on, not the
  space's default.
- **Apps:** an agent's `publish` asks its person with where the app will be ("wants to publish Shop
  at https://shop.copilotz.app").
- **`org.me`** isn't recorded (it only reads), so reads (queries, Views) ask it too.
- **The local cloud host** is one per app and account, whichever executor asks: with several
  executors, a VM one started was turned away by another.

## 1.0.0-rc.5 — 2026-10-30

- **Cloud computers** (plugin `cloud`, see design/cloud-computers.md): computers the app hosts for
  its people. A cloud computer is a disk; a VM from a pool serves it for one wake, then goes.
  `cloud.create` `{ size, in?, name? }` makes one (an org's owners and admins, or its members when
  the settings say, under the org's monthly `budgetUsd`); work for one that's asleep wakes it (a few
  seconds; about 30 from cold); unused for `warmMinutes` (10) it's released, and after `coldDays`
  (7) it goes cold, kept as a snapshot. A person with it open (`computer.view`, every few minutes
  from its panel) keeps it awake up to `viewMinutes` (120). Its agents ask their person nothing
  first (the `cloud` settings' `approve`, `[]` by default, in place of the computers plugin's;
  publishing an app is always asked). `cloud.destroy`, `cloud.org`, queries `cloudComputer.mine` and
  `cloudComputer.sizes` (each size priced an hour). Hosts are adapters: Compute Engine (`gceHost`:
  managed instance groups as pools, pd-balanced disks, VMs admitted by their Google identity tokens)
  and a local one for development and tests. Metered under `computer` as `cloud/<size>` (VM
  seconds), `cloud/disk` and `cloud/snapshot` (GB-hours).
- **Cloud pools** (plugin `cloudPool`): the pools' VMs, where they connect (the `pool` worker kind),
  and the Actions `cloud` reaches them through: `pool.take`, `pool.serve`, `pool.stop`, `pool.drop`,
  `pool.renew`, and `pool.tick` each minute (pools sized by the hour). Each VM given is leased:
  renewed each minute while its computer uses it, deleted once nobody does. A VM serving a computer
  connects again as itself when its socket drops, until it's told to stop; then, or gone, never
  again. One runtime has both plugins; an app of many orgs runs `cloudPool` once (its directory's
  runtime, needing nothing else) and gives each org's runtime `remotePool(call, org)`, the same
  Actions forwarded there, each org touching only its own VMs.
- **Computer program:** `computer pool --app <url>`, a free VM of an app's pool: it waits to serve a
  computer, mounts its disk, and runs it, connected at the address it's told (its org's). Given the
  app's socket (`wss://…`), its identity is still for the app's https origin. scripts/cloud has a
  Google Cloud project's setup and the pool VMs' startup script.
- **Previews:** what a job serves, at `https://<computer>-preview.<domain>`, carried to the computer
  over its own connection (no inbound network), streamed both ways (`computer.http`). For a space's
  members (a signed cookie, given by the app) or anyone with the link. `computer.preview`,
  `computer.previews`, `computer.unpreview`, and the agents' `preview` tool. Settings
  `computers.previews` `{ domain, key }`. WebSockets aren't carried yet.
- **Apps** (plugin `apps`): what a job serves, published to run on its own at
  `https://<label>.copilotz.app`. The space's folder is archived by its computer
  (`computer.archive`), built (its Dockerfile, else buildpacks) and deployed as a service that
  scales to zero. `app.publish` (and the agents' `publish` tool, always asked), `app.list`,
  `app.redeploy`, `app.remove`; builds and running metered under `app`. Hosts: Cloud Run
  (`cloudRun`) and a local one (`localApps`).
- **Apps' safety:** services and images are named `cz-app-<name>` (an app never replaces another
  service in its project); builds run as `cz-build@<project>` (`buildServiceAccount`), never the
  project's default service account, as they run the app's own Dockerfile. `app.publish`'s `port`
  wins over its job's.
- **Previews' safety:** a preview's `Set-Cookie` loses its `Domain` (no preview sets cookies for the
  domain's other hosts); a request with several `cz_preview` cookies gets in when any is its host's.
- **Jobs** can say their `port` (a preview's) and be kept (`keep`): a kept job runs again when its
  computer wakes.
- **A person's panel** (`computer.work`): `wake` wakes a computer that sleeps (its page opened);
  what only reads (`jobs.list`, `jobs.logs`, `files.list`, `files.read`, `search`) neither wakes it
  nor keeps it awake, so a page left open lets it sleep (`computer.view` keeps it awake while
  viewed, up to the limit). A computer the app makes says what its agents ask about
  (`computer.provision`'s `approve`, kept on it and its desks).
- **On the web** (`copilotz/plugins/compute/web`: `computersWeb`, `cloudWeb`, `appsWeb`):
  - adding a computer is one choice: a cloud computer (its sizes, priced an hour), your own machine,
    or one of yours;
  - a cloud computer shows its state, how long it's been awake and about what that came to; asleep,
    waking it, with honest progress; deleting it, asked first;
  - a job serving a port can be previewed (members, or anyone with the link), opened, copied and
    published as an app (live as it builds), and a space has an Apps tab;
  - jobs can be kept running.
- **Web host:** routes by host (`{ host }` beside `{ path }`); a trusted front (`front`: a secret
  header and the host it forwards) for apps behind a proxy; orgs claim hosts in the directory
  (`orgHost`), resolved at `/__copilotz/hosts/resolve`.
- **Runtime:** `runtime.workers.dispatch(kind, id, workload, body?)`, for host code (a route)
  streaming work to a connected worker.
- **Usage:** `usage.quote` prices quantities as a use would be, without recording one.

## 1.0.0-rc.4 — 2026-10-30

- **Usage: every use has a price.** It's the cost (a margin of 0) unless the app's price book says
  otherwise: rates of its own, or a gross `margin` on the cost (`{ margin: 0.9 }` is ten times the
  cost), from its `since` date on. `markup` is gone: a margin says it. Uses recorded before count at
  their cost, in totals and when re-rated.
- **Usage: by part.** Each record keeps its cost and price by part (input, cache reads, cache
  writes, output, reasoning…) and what caching saved; totals and rollups sum them.
- **Usage: people see prices.** `usage.totals`, `usage.org` and `usage.calls` give people prices
  only; costs (and so margins) only platform staff and the system. Each of `usage.org` and
  `usage.calls` says whether it shows costs (`costs`).
- **Usage page and `/usage`:** spend (the price) everywhere, with caching visible: hit rate, what
  reading and writing the cache was charged, and what it saved, overall and by model; cached tokens
  in the chart and in each call. Platform staff also see cost and gross margin, marked staff-only.
- **Models:** OpenAI-compatible providers' cache reads and writes are read as each reports them
  (DeepSeek's cache hits, Moonshot's cached tokens, OpenRouter's cache writes).

## 1.0.0-rc.3 — 2026-10-30

- **Computers:** connecting one more app (`computer install <app> --code`) no longer stops the
  computer running in the background: it enrolls beside it, then that one starts again with every
  app. Turned away, the background one runs on as it was (before, a code refused while it was
  stopping left it stopped). The state's lock waits a moment for one that's stopping.
- **Computers:** a new app's folder never takes the name of a space folder kept in the root by a
  computer from before apps had folders of their own.
- **Install script:** it always says, last, how the terminal it ran in gets `computer` (new ones
  have it).

## 1.0.0-rc.2 — 2026-10-30

- **Orgs:** an org's socket is in its own address (`/o/<org>/oxian`), beside the shared `/oxian`, so
  a browser that sends no cookies with a WebSocket (Safari) reaches its org. The web host's page
  says which socket to use (`socket`) and its base (`base`).
- **Web:** a person shows as their name, from their profile, not as their id: the viewer has a
  `label` beside its `name`, which the shell's account menu and the chat's greeting use.
- **Computers:** one machine serves many apps, or many orgs of one. Each is a computer of its own
  there, with its own id and secret, all in one program; a state kept before becomes its one
  connection. `computer list` says which and where; `computer disconnect <app-url>` leaves one. An
  org's spaces go in a folder named for the org (`~/Copilotz/acme-studio`, `~/Copilotz/personal`): a
  code made on an org says it (`folder`), and the install lines pass it on (`--folder`).
- **The computer program's release:** each release on GitHub has it, made by the publish workflow on
  a Mac. When the program is the same as the last release's (`source` in its manifest), the release
  has that one's binaries, version and all, so computers don't download what they have.
  `computerDownloads()` serves this Copilotz's own release by default.

## 1.0.0-rc.1 — 2026-10-30

Copilotz 1.0 is a new runtime, written from scratch: one runtime for agents and the apps around
them, on Node, Deno, Bun, Cloudflare Workers and the browser. It's published as `copilotz` on npm
(Node first) and as `@copilotz/copilotz` on JSR.

- **Primitives only:** the runtime knows plugins, collections (JSON Schema, with the MongoDB
  collection API), Actions, Processors, Views, resources and adapters, and never what a plugin is
  for. Everything durable is an event, a document (node), an edge, a vector or a blob, in one store
  with one writer (the owner); executors run plugin code beside it or elsewhere, over Oxian.
- **Plugins, by theme:** models (llm, embeddings, transcription, with the models.dev catalog),
  agents (chat, history, memory, team, skills, routines), access (spaces, identity, Google sign-in,
  connected accounts, the directory of orgs), billing (the usage ledger), compute (computers people
  connect, on macOS, Linux and Windows) and interfaces (the terminal and web shells, the developer
  API, WhatsApp).
- **Stores:** memory, SQLite and PostgreSQL (a server, or PGlite), with the same MongoDB semantics
  and one conformance suite; blobs in the store, in files or in a bucket over HTTP. On PostgreSQL,
  many orgs share a schema, each a tenant, over one pool of connections per process; a tenant's rows
  are copied, exported (as SQL) or dropped on their own.
- **Hosts:** the terminal (Ink) and the web (React 19 in the browser, signed in as a person under
  the access rules, with a design system an app rebrands by one theme resource), and orgs: many orgs
  behind one address, each a runtime of its own, opened when used, and reached by its own address
  too (`/o/<org>`) by what has no browser session: API keys, webhooks, computers. On Node,
  `copilotz/web/node` bundles the browser's code with esbuild and serves the web host, its sockets
  through Oxian's Node adapter, for one runtime or one per org.
- **Entry points:** `copilotz`, `copilotz/stores/*`, `copilotz/blobs/*`, `copilotz/plugins/<theme>`
  with its `web` and `terminal` front ends, `copilotz/web` (with `server`, `tickets`, `theme` and
  `node`), `copilotz/orgs`, `copilotz/terminal`, `copilotz/exporters` and `copilotz/testing`; the
  same names on JSR.
- **Metrics:** the runtime and plugins measure themselves the OpenTelemetry way, exported as OTLP or
  Prometheus text.

1.0 doesn't read 0.x data, and there's no migration: a 1.0 app starts with a new database. Copilotz
0.x lives on the [`v0`](https://github.com/copilotzhq/copilotz/tree/v0) branch, where its releases
and their changelog continue; its last release is 0.90.2.
