# Cloud computers, previews and apps

Proposed 2026-10-30, for review. Computers an app hosts for its people and agents (on Google Cloud
first): the same computer program people run on their own machines, from a pool of VMs, waking in
seconds. Also previews of what a job serves, and publishing a job as an app that runs on its own.

## A cloud computer is the same program

- **Same contract.** It's an Oxian worker of the computers plugin's `computer` kind, serving the
  terminal, jobs, files, the browser and web search, with a folder per space and a shell, jobs and
  browser per agent. Spaces, desks, sharing, approvals and the live browser don't change.
- **Made by the app, not enrolled with a code.** Creating one makes its record and its secret
  directly. It belongs to a person (shared into spaces like any computer) or to an org, and its use
  is billed to the org.
- **A computer is a disk, not a VM.** Its disk holds everything about it:
  - its spaces' folders and the browser profiles;
  - its state (`computer.json`: its id and secret);
  - the jobs it keeps running.

  A VM from the pool serves it for one wake, then goes.
- **Sizes**, for example:
  - small: e2-medium, 2 shared vCPU, 4 GB;
  - standard: 2 dedicated vCPU (c4a or n4).

  A 10 GB disk to start, grown when it fills.

## Its life

| Step               | What happens                                                                                                    | Measured                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Create**         | Its disk is made; it's formatted on first wake                                                                  | 4 s + 4 s                             |
| **Wake**           | A free VM in the disk's zone attaches the disk, mounts it, connects as the computer, and restarts its kept jobs | **4.3 s** to mounted, ~1 s to connect |
| **Warm**           | The VM stays with it while it's used, and for `warm` minutes after (10 by default): calls go straight through   | —                                     |
| **Release**        | The program stops its jobs (keeping the list) and unmounts; the disk is detached and **the VM is deleted**      | ~16 s, after the warm window          |
| **Cold**           | After `cold` days unused, the disk is snapshotted (in the background) and deleted                               | 91 s per GB                           |
| **Wake from cold** | The disk is made again from its snapshot first                                                                  | +~25 s (~29 s to mounted)             |
| **Destroy**        | Its disk and snapshots are deleted                                                                              | —                                     |

- **A wake** happens when an agent's tool call, or a person opening it, reaches a computer that's
  asleep. The call waits while it wakes, and the agent sees "waking the computer…".
- **VMs are used once.** Agents may be root on their computer (installing packages), so a VM that
  served one computer never serves another. Released, it's deleted.
- **No suspend.** Suspending took 460 s to save memory, and resuming (19 s) is slower than a wake
  from the pool. A warm window keeps a VM running instead. After it, kept jobs restart on the next
  wake.
- **Failures:**
  - **A VM that dies** leaves its computer asleep. The next call wakes it on another VM, with the
    disk detached by force.
  - **A zone without capacity** wakes it in another zone, from its latest snapshot (the slow path).

## The pool

- **One managed instance group per zone,** of free VMs, all from one image: the compiled computer
  program (Linux), Chrome, git, Node, Python and build tools.
- **Each free VM runs `computer pool`.** It connects to the app over the same Oxian connection, as a
  `pool` worker, saying it's free in its zone. Its pool token lets it do nothing else.
- **Taking one:** the app removes it from its group (`abandon`) and sizes the group back up. The
  group makes a replacement (59 s measured).
- **Sizing:** every minute the app sets each group's size to the wakes it expects before a
  replacement is ready (about 2 minutes), plus a floor. The floor follows the hour, and can be 0: a
  wake then boots a VM (34–45 s measured).
- **Updates:** the image (family `cz-computer`) carries the tools and a program. Each VM checks the
  release its template names when it boots, and downloads that program if it's newer. A new release
  or app address is a new template version, and the groups roll it out.
- **Leases:** a VM serves its computer while the computer's app renews its lease (every minute, for
  10 minutes). The pool deletes a VM whose lease lapses: its app stopped, or forgot it. Its disk
  stays, and the computer wakes again on its next use.

### In a multi-org app (Compass)

- **The pool is the app's, not an org's** (plugin `cloudPool`). It runs where pool VMs connect:
  - in an app of one runtime, that runtime;
  - in Compass, the directory, at its own socket (`wss://<app>/__pool/oxian`).
- **Each org's cloud computers** (plugin `cloud`) reach the pool only through its Actions:
  `pool.take`, `pool.serve`, `pool.stop`, `pool.drop` and `pool.renew`. In Compass these are
  forwarded to the directory (`remotePool`), which records whose org each VM serves.
- **Assigned, a VM's computer connects to its org's address** (`PoolAssign.app`: `<app>/o/<org>`),
  as a person's computer does. Its pool connection stays with the directory, for its release.

## The program

- **`computer pool --app <url>`.** It waits for an assignment. Given one, it:
  - mounts the computer's disk as its root;
  - reads the computer's state from it;
  - runs the computer (`startComputer`, as on a laptop);
  - says when it was last used.

  Asked to release, it stops the computer and its jobs, keeps the list of jobs to restart, unmounts,
  and says so.
- **Jobs** gain `keep` (restarted on wake) and `port` (what they serve, for previews).

## The app's side

- **Plugin `cloud`** (each org):
  - actions `cloud.create`, `wake`, `release`, `destroy`, `touch`, `org`;
  - records for a cloud computer (its disk, zone, project, and
    `cold | asleep | waking | awake | releasing`);
  - the computers plugin's wake hook (`computerWake`): work for a computer that's asleep wakes it
    first;
  - schedules: idle releases, metering and lease renewals each minute; cold snapshots daily.
- **Plugin `cloudPool`** (the app's): pool VMs (`free | assigned | gone`, and whose), their
  admission, sizing each minute, and leases.
- **The host is a port** (`cloudHost`), with these adapters:
  - Compute Engine: disks, attach and detach, snapshots, instance groups;
  - Docker, for development and tests.

  GKE Agent Sandbox and Google's announced Agent Compute Engine could be adapters later.
- **Placement** is per computer: its project and zone, chosen with headroom. Beyond one project's
  quotas, another project is a new placement, not a new design.

## Isolation

- **Each wake gets its own VM,** deleted when it's done. Nothing is reused across computers.
- **Pool VMs run as a service account with no roles and no scopes** (`cz-pool`: its identity tokens
  prove which VM it is, and nothing more), with no inbound ports. Everything runs over their
  outbound connection.
- **Egress** reaches the internet. Firewall rules block private ranges, so a computer can't reach
  other VMs or internal services.
- **Secrets:** a computer's secret lives on its own disk. A pool token can only register a free VM
  and take assignments.
- **Re-admission:** a VM that served a computer never serves another. While it serves one, it may
  connect again as itself (Cloud Run drops sockets hourly), and is only ever sent that computer's
  release.
- **Apps' builds** run the app's own Dockerfile, so they run as `cz-build` (push to the apps'
  repository, read the sources, write logs), never the project's default service account. Apps run
  as `cz-apps` (no roles), and their services are named `cz-app-<name>`, so an app never replaces
  another service in the project.
- **The user-content domain:** previews and apps are on `copilotz.app`, never the app's domain. A
  preview's `Set-Cookie` loses its `Domain`, so no preview sets cookies for the others. Listing
  `copilotz.app` in the Public Suffix List would do the same for apps (to do).
- **Abuse** (mining, attacks from our IPs) calls for per-org limits and budgets, and egress
  metering. These come before the broad release.

## Metering and pricing

- **Compute:** `meter: "computer"`, subject `cloud/<size>`.
  - It counts `seconds` from assignment to release, the warm window included.
  - It's recorded each minute while awake, so spend stays current, and again at release.
- **Storage:** subjects `cloud/disk` and `cloud/snapshot`, counting GB-hours. They're recorded
  daily.
- **Costs** go in the app's cost book, from Google's prices. These are still to be checked against
  the Billing Catalog:

  | Item             | Price           |
  | ---------------- | --------------- |
  | e2-medium        | $0.0335/h       |
  | external IP      | $0.005/h        |
  | pd-balanced disk | $0.10/GB-month  |
  | snapshot         | ~$0.05/GB-month |

- **Prices** use the usage plugin's margins: `{ "cloud/*": { margin: 0.9 } }` for compute, so ten
  times its cost, about $0.40/h for small. People see spend, never cost.
- **The pool, load balancer and other fixed costs** aren't charged to anyone. They're the platform's
  overhead (below).

## Previews: what a job serves

- **A job says the port it serves,** or the program finds the port it listens on.
- **The preview URL** is `https://<preview>-preview.copilotz.app/`, on the user-content domain (see
  Domains). It's per host, so a site's absolute paths work, and it's one label deep, so Cloudflare's
  free wildcard certificate covers it.
- **Routing:** the app's web host sends each request to the computer's own connection, as an HTTP
  workload (`computer.http`), which forwards it to `127.0.0.1:<port>`.
  - It needs no inbound network, so it works for personal and cloud computers alike.
  - It uses Oxian's HTTP workload. WebSockets through it, for hot reload, are marked unreleased in
    Oxian's docs and need verifying first.
- **Access:** org members by default, through a short-lived link that becomes a cookie for that
  host. "Anyone with the link" is optional.
- **Traffic goes through the app's process.** That's right for development, not for an app's real
  users (see Apps).
- **The front** is the Cloudflare worker we already have: no load balancer to pay for.

## Apps: publishing a job

- **Publish** takes a job that serves a port, and makes it an app that runs without its computer:
  - the folder is uploaded as an archive;
  - an image is built: the folder's Dockerfile, else buildpacks (Cloud Build: $0.006/minute after
    2,500 free a month);
  - it's deployed as a Cloud Run service that scales to zero.

  Services run in an apps project, with service accounts allowed nothing.
- **Revisions:** each publish is a new revision, and rolling back routes to an older one. Settings
  and secrets come from the space.
- **URL:** `https://<app>.copilotz.app`. The Cloudflare worker routes each app's host straight to
  its Cloud Run URL, from a small table the app keeps, so there's no Google load balancer. Custom
  domains go through Cloudflare for SaaS (custom hostnames: 100 free, then about $0.10 each a
  month).
- **Records:** `app` holds its space, name, source (computer, folder, command, port), revisions,
  URL, domains and visibility.
- **Agent tools:** `preview(job)` and `publish(job)`.
- **Metering:** build minutes, plus each service's vCPU and GiB seconds and requests, priced with
  the same margins.
- **Scale:** 1,000 Cloud Run services per region per project; more projects past that.

## Scale

- **What grows with use:**
  - VMs: about the computers awake at once, plus the free pool;
  - operations per wake: about 5 (attach, abandon, resize, detach, delete).

  At the default 500 operations in flight, that's ~5 wakes a second, ~18,000 an hour, per project
  and region.
- **What doesn't:** computers that exist but sleep are disks or snapshots.
- **This project still has default quotas:** 24 VMs and 24 E2 vCPUs in the region, 32 vCPUs in all.
  That's about 12 computers awake at once, so increases are needed before launch.

## Holding cost when idle

| Item                                                                                 | Per month      |
| ------------------------------------------------------------------------------------ | -------------- |
| Free pool, floor of 1 VM in one zone, always: e2-medium + 10 GB boot disk + IP       | ~$29           |
| Free pool, floor of 1 in working hours only (~264 h)                                 | ~$10           |
| Free pool, floor of 0 (wakes boot, ~45 s)                                            | $0             |
| The front for previews and apps: the Cloudflare worker we already run                | $0             |
| Certificates (first 100), templates, instance groups, the app-side controller        | $0             |
| Images and Artifact Registry (first 0.5 GB free)                                     | < $1           |
| **Total, nobody using it**                                                           | **$0 to ~$30** |
| Each computer that exists but sleeps: its 10 GB disk, or ~$0.05/GB of data once cold | ~$1, or cents  |

## Measured (2026-10-30)

e2-medium VMs with Debian 12, in us-central1-a, with 10 GB pd-balanced disks and no external IP.

| Step                                                    | Time            |
| ------------------------------------------------------- | --------------- |
| New VM to ready (create call ~20 s, guest boot 13–23 s) | 34, 44, 45 s    |
| Attach a disk to a running VM, mounted (formatted)      | 4.2, 4.4, 4.4 s |
| Attach and format a blank disk                          | 4.3 s           |
| Unmount + detach                                        | ~13–16 s        |
| Snapshot, 1 GB of data                                  | 91 s            |
| Disk from snapshot / mounted from snapshot              | 24.5 s / 29 s   |
| Stop / start to ready                                   | 113 s / 31 s    |
| Suspend / resume to running                             | 460 s / 19 s    |
| Instance group: take one, replacement ready             | 59 s            |

## In order

1. **Previews**, for computers on people's machines first.
2. **Cloud computers:**
   - `computer pool`;
   - the app's side, with the Compute Engine and Docker adapters;
   - metering;
   - the quota increases.
3. **Publishing apps.**
4. **Later:**
   - images per stack (templates);
   - per-org budgets and limits;
   - other hosts (GKE Agent Sandbox, Agent Compute Engine).

## Domains

- **The app** moves to `compass.copilotz.com`.
- **What people's computers and apps serve** gets its own registrable domain: `copilotz.app`.
  - Previews are `<id>-preview.copilotz.app` and apps are `<app>.copilotz.app`.
  - Content on the app's own domain could set cookies the app trusts, which is why GitHub serves
    user content from `github.io`.
  - Later, `copilotz.app` goes on the Public Suffix List, so each app is a site of its own to
    browsers.
- **Both are on Cloudflare,** behind the worker we already run.
- **`copilotz.app` serves the previous app today.** It becomes the user-content domain once that app
  has moved, which fits the switch already planned (people move to the new app, then the old one
  goes).

## In an org's own cloud (later)

Enterprises may want computers, and later more, in their own Google Cloud. The design keeps that
open, at three depths:

1. **Computers in their cloud.** The app keeps running ours; their computers' disks and VMs live in
   their project.
   - Their VMs connect out to the app, as ours do: no inbound ports.
   - Their VMs can reach their private network directly.
   - Google bills them for the VMs, so their cost in our books is 0, and the price is whatever we
     charge for the service.

   It works one of two ways:
   - they grant our controller's service account roles on their project;
   - or, closer to what enterprises prefer, they run the host adapter themselves in their project: a
     small worker that connects out to the app and carries out its pool operations with their own
     service account. Then they grant us nothing.
2. **Their data in their database.** Tenancy already places a big org in a schema or a database of
   its own; that database can be theirs.
3. **The whole app in their cloud,** self-hosted from the same packages and images.

What keeps the first open, at little cost now:

- a placement says **whose account** as well as project and zone;
- the host adapter is built per placement, with its own credentials, never one global client;
- pools are per placement;
- the image comes from the public release;
- cost books are per placement;
- nothing in the plugin names our project.

## Defaults (confirmed 2026-10-30)

- **Margins:**
  - compute: 90%, ten times its cost (~$0.40/h for small);
  - storage: 50%, twice its cost (a sleeping 10 GB computer ~$2/month).

  After 7 days unused, a computer's disk goes cold (a snapshot), billed on its data. For reference,
  GitHub Codespaces lists 2 dedicated cores at $0.18/h and storage at $0.07/GB-month.
- **Warm window:** 10 minutes after the last activity (an agent's call, a person's input). A
  computer also stays awake while a person has its terminal or a preview open, up to 2 hours. It's
  an org setting.
- **Pool:** one zone, with a floor of 1 free VM in working hours and 0 at night (~$10/month). The
  pool follows the wake rate as use grows, and gains zones when capacity or failover needs them.
- **Sizes:**
  - small: e2-medium, 2 shared vCPU, 4 GB;
  - standard: 2 dedicated vCPU, 8 GB (n2-standard-2: N4 and C4A take Hyperdisk only, and computers'
    disks are pd-balanced).

  Large (4 vCPU, 16 GB) comes when builds need it.
- **Who creates them:** org admins by default; an org setting opens it to members. A monthly budget
  per org stops creation when it's reached.
- **Approvals on cloud computers:**
  - off by default for commands, jobs and writes (the computer is isolated);
  - always asked for what reaches outside it: publishing an app, and using connected accounts.

  An org can turn the rest back on.
