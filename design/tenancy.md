# Orgs, the directory, and running many of them

Agreed 2026-10-29/30. How an app on Copilotz serves many organisations: what an org is, where its
data lives, how people sign in and move between orgs, who administers what, and how it runs.

## An org is a tenant

- **Everything an org has lives in its own tenant:** its people (with their org role), sessions,
  keys, spaces, conversations, agents, computers, memories, files and usage. An org exports, moves
  and is deleted as a unit.
- **Each org has its own single writer** (its owner) and so its own order of events. One org's load,
  or a writer stuck on it, never holds up another.
- **Everyone has a personal org.** Signing in the first time makes one, holding just you and your
  Personal space. Team orgs are made by people, or joined by invitation. Nobody is placed in an org
  because of their email's domain unless that org turned it on (below).
- **Spaces stay inside an org.** Someone from outside joins as a guest, who reaches only the spaces
  they're invited to. Spaces shared across orgs are left for later.

## Where an org's rows live

- **The store is tenant-scoped.** The Postgres store is bound to `(schema, tenant)`, and every
  statement it makes is scoped to its tenant: isolation never depends on rules being right.
- **The six tables carry `tenant`**, leading every key and index:
  - events are numbered per org (`(tenant, seq)`), by the org's writer;
  - blobs are keyed `(tenant, id)`, so content dedupes within an org, never across;
  - `meta (tenant, key)` holds each org's write epoch and its observers' positions.
- **Placement is a deployment choice:**
  - small and personal orgs share a few pooled schemas;
  - a big org gets a schema, or a database, of its own.

  Nothing grows with sign-ups: schemas stay few however many people sign up.
- **Moving an org** means fencing its writer, copying its rows by tenant (seconds for a pooled org;
  nothing is renumbered), routing it to the new place, starting its writer there, then deleting the
  old rows.
- **Exporting:**
  - raw rows by tenant, in one consistent snapshot, for moving and restoring;
  - a JSON export for the org's admins (documents by collection, the event log, files), read through
    the owner so the rules decide.
- **Deleting an org** removes its rows in batches in the background.
- **Connections:** one pool per process (`postgresPool`), shared by every org it hosts, in two
  lanes: commits and reads. A store takes a connection for a statement, or a transaction while it is
  open, and gives it back, so an idle org holds none and a busy one only while it commits.
- SQLite and memory stores stay one org per store.

## The directory: routing only

A small runtime of its own, holding only what routing needs:

- **sign-ins:** accounts as their sign-in method knows them (Google today), with their verified
  email;
- **which orgs each account belongs to**, so it can list them and let them in;
- **invitations to orgs**, by verified email, pending until accepted;
- **where each org lives** (its placement) and a small summary it reports (members, size, last
  active, daily usage) for the platform console;
- **verified domains:** an org that verified `acme.com` may turn on "anyone at @acme.com can join";
- **platform staff.**

People inside an org are known by their verified email, the same in every org, so the directory's
membership and the org's own people line up without a mapping.

Since 2026-11-09 the directory is a product package, `@copilotz/directory` (see
[plugins.md](plugins.md)): an app serving one org has none of it. Its front end (`directoryWeb`)
fills the web shell's `orgs` slot (the switcher, going between orgs, staff's line) and draws the
org's page (`/org`) and the platform console (`/console`); the roles in an org, below, stay the
spaces plugin's, in every org's runtime.

## Signing in and entering an org

- **Sign in once,** at the directory, with its sign-in routes (`/signin/google`, `/signin/dev`): its
  session is identity's, in the `dir` cookie.
- **Entering an org is signing in to it.** The directory checks the account belongs to the org
  (`org.enter`), then hands the browser over with a signed handoff: a minute long, and never out of
  the process. The org's own `POST /enter` (at `/o/<org>/enter`, which only a handoff opens) keeps
  what the directory verified about the person (`person.set`), joins them the first time, starts its
  own session (`session.start`) and sets its own cookie (`s_<org>`). Sessions stay inside the org,
  as everything else does.
- **The org switcher** lists the account's orgs, and creates new ones. Entering another org swaps
  which org the browser is in (the `org` cookie); each org's session is kept, so switching back is
  instant.
- **Addressing:** one host serves every org, so the app works on a single address such as a Cloud
  Run URL. A browser's page goes to the org it's in (its `org` cookie); everything else that names
  an org goes by its address, `/o/<org>/…` (a key, a webhook, a computer, and the page's own
  `/connect` and socket). An org may also claim a host of its own (a preview's, an app's), which
  then reaches only that org's routes by host.

## One address: the directory's routes

Built 2026-11-06, in place of the orgs host (`copilotz/orgs`, gone). The directory is an ordinary
runtime whose `fetch` is the whole app's (`Deno.serve(dir.fetch)`, or `listen(dir.fetch)` on Node).
Its plugin's routes answer what's the directory's, and hand everything else, untouched (its path,
its body, its socket), to the org's own `runtime.fetch`, which answers it by the org's own `who`:

- **`/o/<org>/…`:** that org, by its address: 404 for no such org, 403 for a suspended one.
- **`/*`** (matched last): the org the browser is in (`org`), with its session there. A page asked
  for without one (signed in at the directory but in no org yet, its session there gone, the org no
  longer theirs or suspended) goes in first: the org they were in, else their last, else their own,
  made now; then the same page again (a 302). Anything else for someone signed in nowhere is the
  lobby's (`directory.lobby`: the sign-in page, a runtime with the page plugin).
- **A host an org claimed** (a route for every host but the app's own, which `hosts` names): that
  org's host routes alone; `GET /__copilotz/hosts/resolve?host=` says whose a host is, for the app's
  front.
- **Its own:** `GET /orgs` and `POST /orgs` (the account's orgs, a new one), `POST /orgs/enter`,
  `POST /orgs/invites/answer`, `POST /signout` out of every org it holds a session for (each ends
  where its org is open; signing out never opens one), and staff's `/console/orgs…` and
  `/console/codes…`.

**Each org's runtime** is the app's plugins plus `directory.member(dir, org)`, which gives it:

- which org it is (`resources.org`: its id, name, kind and address) and where it's served
  (`page.base`: `/o/<org>`, so its page, its `/connect` and its socket work at its address);
- its cookies' names (below);
- the app's own hosts (`hosts`), so a host it claimed reaches only its host routes;
- how it reaches the directory (`resources.directory`): invitations, leaving, renaming, claiming a
  host, gift codes; and its `/enter`.

**Which org a request is for** is a query (`org.info`), kept 10 seconds; hosts' claims are kept a
minute; each is forgotten at once when the directory changes it.

**What else lives in the directory's runtime:** whatever has one address for every org. Stripe's
webhook (`stripeWebhook`, `POST /__stripe/<seller>`) checks the signature, then hands each fact to
its org's runtime as `billing.apply` (the `stripe` resource's `orgs`); an app's own plugins with one
address may live there too (Compass's pool of cloud computers, whose VMs connect at its route).
Visitors on every org's site chats are counted together with one `contactsPool()` given to each
org's runtime.

### Cookies per org

Every cookie keeps the name it had before forwarding, so nobody signs in again. The runtime knows
nothing of orgs: each runtime's `cookies` resource renames what its plugins set.

| Cookie                               | Name                  | Set by                                                  |
| ------------------------------------ | --------------------- | ------------------------------------------------------- |
| the directory's session              | `__Host-dir`          | the directory plugin: `{ names: { session: "dir" } }`   |
| which org the browser is in          | `__Host-org`          | the directory                                           |
| an org's session                     | `__Host-s_<org>`      | `directory.member`: `{ names: { session: "s_<org>" } }` |
| an org's other cookies (a visitor's) | `__Host-<name>_<org>` | `directory.member`: `{ suffix: "_<org>" }`              |

(`__Host-` wherever the cookie is Secure: over plain http to this machine, the plain name.)

### The pool

`runtimes(open, { idleMs })` (the runtime's) keeps the orgs' runtimes: the app says how to open one
(`open(id)`: the org's store and plugins, `directory.member` among them; undefined for no such org),
and gives the pool to the directory (`directory: { orgs }`).

- `get(id)` opens it on its first use, and hands the same one after; a failed opening is tried again
  on the next `get`.
- One with no browsers and nothing pending for `idleMs` since its last use (30 minutes unless said)
  closes, and opens again on its next use.
- `close(id)` closes one now (staff moving its rows); a `get` meanwhile opens another only once it
  has closed, so an org's store never has two writers. `close()` closes them all, for good.

**Sockets** are forwarded like any request. On Node, Oxian's listener waits for the runtime's answer
before it decides an upgrade (Oxian 0.23.4), so the org's runtime can be opened first; under
`Deno.serve`, a socket Deno handed the directory is still Deno's to accept in the org's runtime.

## Roles

- **In an org:** owner, admin, member, guest.
  - **Owners and admins have owner access to everything in the org,** as in Google Workspace: every
    space (Personal spaces included), conversation, agent, computer and memory. That lets them
    manage what someone leaves behind and hand it over. Members are told so in the app.
  - Members reach the spaces they're members of; guests only those they were invited to.
- **Platform staff,** for now, have the same access in every org. Everything they do is recorded as
  theirs in the org's event log and shows in its activity.
- **Agents** are unchanged. They act for whoever asked, narrowed to the conversation's space, even
  when that person is an admin.

## A job's authority is the owner's to give

The owner records each job's actor when it dispatches it, and checks every op the job sends against
it. An op acts as that actor; trusted code that acts for another (`ctx.as()`) keeps whose job it was
(`via`), and only then passes. An executor admitted as bound (`bound:<org>`, an org's own workers)
acts only as its jobs. This is in place, and it's what makes org-run workers possible:

- they're enrolled like computers, with a revocable credential for one org;
- they're sent only that org's own plugins' work;
- they reach models, secrets and connected accounts only through Actions that run on the platform's
  executors.

## Many orgs per process

- A process hosts many orgs. Each org's writer starts on its first request and stops when idle (the
  pool, above).
- A request finds its org by its address, the browser's `org` cookie or a host the org claimed; the
  directory's placement says where its rows are.
- Each org's writer is held by one process at a time and fenced by the org's epoch, so a process
  that takes over an org can't be overlapped by the one before.
- **The first deployment** runs one process holding every org's writer, with the web and executors
  beside it, much as the previous version does. Spreading orgs over several owner processes needs
  hosts that can be addressed one by one: Cloud Run can't route a request to a chosen instance. The
  model already allows it, so that's a hosting change when load calls for it.

## Administration

- **The org admin page** (owners and admins) is made of sections each plugin adds:
  - members and roles, invitations and guests (removing someone ends their sessions and hands their
    work to someone else);
  - spaces;
  - agents and allowed models;
  - usage and cost;
  - activity, from the event log;
  - domains and joining;
  - computers and workers;
  - export and deletion.
- **The platform console** (staff) lists orgs with their summaries, placement and writer state;
  looks people up; and runs operations on an org (move, export, suspend, delete, restart its
  writer). Each operation is an Action, so it's on the record. The console reads no org's content.
- **Health** comes from the metrics the runtime exports; alerts belong to the monitoring system.

## Operations

- **Deploys:** drain the old revision before the new one takes the writers, as before. Each org's
  epoch fences any overlap.
- **Backups:** the database's own backups cover every org. Restoring one org means restoring a
  backup aside and copying that org's rows back.
- Every log line and metric carries the org.
- **Quotas per org** (writes, model spend, workers) come before the broad release, with
  backpressure, not hard failures.

## Computers people install

The computer program is a single executable for macOS, Linux and Windows. The app serves it with
install commands that carry the enrollment code:

- it starts at login and updates itself, checking each download's hash;
- signed and notarized downloads need the signing accounts, before the broad release;
- the Linux build is also what an app's hosted computers run (Compass's cloud computers: its pool
  mode, `copilotz/plugins/compute/program`).
