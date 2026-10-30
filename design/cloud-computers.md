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
- **Updates:** each release builds the image, and the groups roll it out. Pool VMs don't update
  themselves; computers on people's machines still do.

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

- **In the computers plugin:**
  - actions `computer.cloud.create`, `wake`, `release`, `destroy`;
  - records for a cloud computer (its disk, zone, project, and
    `cold | asleep | waking | awake |
    releasing`) and for pool VMs (`free | assigned`, and to
    whom);
  - a dispatch hook: work for a computer that's asleep wakes it first;
  - schedules: pool sizes and idle releases each minute, cold snapshots daily.
- **The host is a port** (`cloudHost`), with these adapters:
  - Compute Engine: disks, attach and detach, snapshots, instance groups;
  - Docker, for development and tests.

  GKE Agent Sandbox and Google's announced Agent Compute Engine could be adapters later.
- **Placement** is per computer: its project and zone, chosen with headroom. Beyond one project's
  quotas, another project is a new placement, not a new design.

## Isolation

- **Each wake gets its own VM,** deleted when it's done. Nothing is reused across computers.
- **Pool VMs have no service account and no inbound ports.** Everything runs over their outbound
  connection.
- **Egress** reaches the internet. Firewall rules block private ranges, so a computer can't reach
  other VMs or internal services.
- **Secrets:** a computer's secret lives on its own disk. A pool token can only register a free VM
  and take assignments.
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
- **The preview URL** is `https://<preview>.preview.<domain>/`. It's per host, so a site's absolute
  paths work.
- **Routing:** the app's web host sends each request to the computer's own connection, as an HTTP
  workload (`computer.http`), which forwards it to `127.0.0.1:<port>`.
  - It needs no inbound network, so it works for personal and cloud computers alike.
  - It uses Oxian's HTTP workload. WebSockets through it, for hot reload, are marked unreleased in
    Oxian's docs and need verifying first.
- **Access:** org members by default, through a short-lived link that becomes a cookie for that
  host. "Anyone with the link" is optional.
- **Traffic goes through the app's process.** That's right for development, not for an app's real
  users (see Apps).
- **The domain** is a wildcard: through the existing Cloudflare front (no cost), or a Google global
  load balancer with a wildcard certificate (~$18/month + $0.008/GiB).

## Apps: publishing a job

- **Publish** takes a job that serves a port, and makes it an app that runs without its computer:
  - the folder is uploaded as an archive;
  - an image is built: the folder's Dockerfile, else buildpacks (Cloud Build: $0.006/minute after
    2,500 free a month);
  - it's deployed as a Cloud Run service that scales to zero.

  Services run in an apps project, with service accounts allowed nothing.
- **Revisions:** each publish is a new revision, and rolling back routes to an older one. Settings
  and secrets come from the space.
- **URL:** `https://<app>.apps.<domain>`, through one load balancer that routes to every service
  (serverless NEG with a URL mask) and a wildcard certificate. Custom domains go through Certificate
  Manager; the first 100 certificates are free.
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
| Load balancer for previews and apps (Google), or the Cloudflare front                | ~$18, or $0    |
| Certificates (first 100), templates, instance groups, the app-side controller        | $0             |
| Images and Artifact Registry (first 0.5 GB free)                                     | < $1           |
| **Total, nobody using it**                                                           | **$0 to ~$50** |
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

## To decide

- **The margin on storage.** At 90%, a sleeping 10 GB computer costs its owner ~$10/month.
- **The warm window** (10 minutes?) and **the pool floor** by hour.
- **The domain:** the Cloudflare front, or a Google load balancer.
- **The sizes** offered, and who may create cloud computers (anyone, within the org's budget, or
  admins only).
- **Approvals on cloud computers:** off by default (it's isolated), or as on people's own machines.
