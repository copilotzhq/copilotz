/**
 * The Compute Engine host (`gceHost`) against a fake Compute Engine: a local
 * server that keeps disks, snapshots, VMs and instance groups, checks what
 * it's asked, and answers changes with operations that finish after a poll
 * or two. No call reaches Google.
 */
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { gceHost, LABELS, regionOf } from "../cloud/adapters/gce/index.ts";
import type { Placement } from "../cloud/contract.ts";
import { serve, test } from "../../../testing/mod.ts";

const here: Placement = { project: "copilotz-485719", zone: "us-central1-a" };
const TOKEN = "test-token";
const GOOGLE = "https://www.googleapis.com/compute/v1";

// deno-lint-ignore no-explicit-any
type Seen = { method: string; path: string; query: Record<string, string>; body?: any };
type Vm = { disks: { source: string; deviceName: string }[]; stuck?: boolean };

/** A fake Compute Engine, and what it was asked. */
async function fakeCompute() {
  const disks = new Map<string, Record<string, unknown>>();
  const snapshots = new Map<string, Record<string, unknown>>();
  const vms = new Map<string, Vm>();
  const groups = new Map<string, { targetSize: number; vms: Map<string, string> }>();
  const operations = new Map<string, { polls: number; need: number; error?: string }>();
  const seen: Seen[] = [];
  /** Answers given before any other: refusals, for retries. */
  const refusals: Response[] = [];
  /** An error the next operation finishes with. */
  let failing: string | undefined;
  let made = 0;

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const notFound = (what: string) =>
    json({ error: { code: 404, message: `The resource '${what}' was not found` } }, 404);
  const operation = (scope: string, target: string, type: string) => {
    const name = `operation-${++made}`;
    operations.set(name, { polls: 0, need: 1 + made % 2, error: failing });
    failing = undefined;
    return json({
      name,
      status: "RUNNING",
      operationType: type,
      targetLink: `${GOOGLE}/projects/${here.project}/${target}`,
      ...(scope === "global" ? {} : { zone: `${GOOGLE}/projects/${here.project}/zones/${scope}` }),
    });
  };

  const server = await serve(async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/compute\/v1/, "");
    const text = await request.text();
    const body = text ? JSON.parse(text) : undefined;
    seen.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body });
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return json({ error: { code: 401, message: "no token" } }, 401);
    }
    const refusal = refusals.shift();
    if (refusal) return refusal;
    const route = `${request.method} ${path}`;
    let m: RegExpMatchArray | null;

    if (
      (m = route.match(
        /^POST \/projects\/[^/]+\/(?:zones\/[^/]+|global)\/operations\/([^/]+)\/wait$/,
      ))
    ) {
      const op = operations.get(m[1])!;
      op.polls++;
      const done = op.polls >= op.need;
      return json({
        name: m[1],
        status: done ? "DONE" : "RUNNING",
        ...(done && op.error
          ? {
            operationType: "insert",
            targetLink: `${GOOGLE}/projects/${here.project}/zones/${here.zone}/disks/d`,
            error: { errors: [{ code: op.error, message: "Quota 'SSD_TOTAL_GB' exceeded." }] },
            httpErrorStatusCode: 403,
          }
          : {}),
      });
    }
    if ((m = route.match(/^POST \/projects\/[^/]+\/zones\/([^/]+)\/disks$/))) {
      disks.set(body.name, body);
      return operation(m[1], `zones/${m[1]}/disks/${body.name}`, "insert");
    }
    if ((m = route.match(/^DELETE \/projects\/[^/]+\/zones\/([^/]+)\/disks\/([^/]+)$/))) {
      if (!disks.delete(m[2])) return notFound(m[2]);
      return operation(m[1], `zones/${m[1]}/disks/${m[2]}`, "delete");
    }
    if (
      (m = route.match(/^POST \/projects\/[^/]+\/zones\/([^/]+)\/disks\/([^/]+)\/createSnapshot$/))
    ) {
      if (!disks.has(m[2])) return notFound(m[2]);
      snapshots.set(body.name, { ...body, sourceDisk: m[2] });
      return operation(m[1], `zones/${m[1]}/disks/${m[2]}`, "createSnapshot");
    }
    if ((m = route.match(/^DELETE \/projects\/[^/]+\/global\/snapshots\/([^/]+)$/))) {
      if (!snapshots.delete(m[1])) return notFound(m[1]);
      return operation("global", `global/snapshots/${m[1]}`, "delete");
    }
    if ((m = route.match(/^GET \/projects\/[^/]+\/zones\/([^/]+)\/instances\/([^/]+)$/))) {
      const vm = vms.get(m[2]);
      return vm ? json({ name: m[2], disks: vm.disks }) : notFound(m[2]);
    }
    if ((m = route.match(/^DELETE \/projects\/[^/]+\/zones\/([^/]+)\/instances\/([^/]+)$/))) {
      if (!vms.delete(m[2])) return notFound(m[2]);
      return operation(m[1], `zones/${m[1]}/instances/${m[2]}`, "delete");
    }
    if (
      (m = route.match(/^POST \/projects\/[^/]+\/zones\/([^/]+)\/instances\/([^/]+)\/attachDisk$/))
    ) {
      const vm = vms.get(m[2]);
      if (!vm) return notFound(m[2]);
      vm.disks.push({ source: `${GOOGLE}/${body.source}`, deviceName: body.deviceName });
      return operation(m[1], `zones/${m[1]}/instances/${m[2]}`, "attachDisk");
    }
    if (
      (m = route.match(/^POST \/projects\/[^/]+\/zones\/([^/]+)\/instances\/([^/]+)\/detachDisk$/))
    ) {
      const vm = vms.get(m[2]);
      if (!vm) return notFound(m[2]);
      if (vm.stuck) {
        return json({ error: { code: 400, message: "The instance doesn't answer" } }, 400);
      }
      vm.disks = vm.disks.filter((d) => d.deviceName !== url.searchParams.get("deviceName"));
      return operation(m[1], `zones/${m[1]}/instances/${m[2]}`, "detachDisk");
    }
    if (
      (m = route.match(/^GET \/projects\/[^/]+\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)$/))
    ) {
      const group = groups.get(m[2]);
      return group ? json({ name: m[2], targetSize: group.targetSize }) : notFound(m[2]);
    }
    if (
      (m = route.match(
        /^POST \/projects\/[^/]+\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)\/listManagedInstances$/,
      ))
    ) {
      const group = groups.get(m[2])!;
      // Two to a page, to show it reads every page.
      const all = [...group.vms].map(([name, currentAction]) => ({
        instance: `${GOOGLE}/projects/${here.project}/zones/${m![1]}/instances/${name}`,
        currentAction,
      }));
      const from = Number(url.searchParams.get("pageToken") ?? 0);
      return json({
        managedInstances: all.slice(from, from + 2),
        ...(from + 2 < all.length ? { nextPageToken: String(from + 2) } : {}),
      });
    }
    if (
      (m = route.match(
        /^POST \/projects\/[^/]+\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)\/resize$/,
      ))
    ) {
      groups.get(m[2])!.targetSize = Number(url.searchParams.get("size"));
      return operation(
        m[1],
        `zones/${m[1]}/instanceGroupManagers/${m[2]}`,
        "compute.instanceGroupManagers.resize",
      );
    }
    if (
      (m = route.match(
        /^POST \/projects\/[^/]+\/zones\/([^/]+)\/instanceGroupManagers\/([^/]+)\/abandonInstances$/,
      ))
    ) {
      const group = groups.get(m[2])!;
      for (const instance of body.instances as string[]) {
        group.vms.set(instance.slice(instance.lastIndexOf("/") + 1), "ABANDONING");
        group.targetSize--;
      }
      return operation(
        m[1],
        `zones/${m[1]}/instanceGroupManagers/${m[2]}`,
        "compute.instanceGroupManagers.abandonInstances",
      );
    }
    return json({ error: { code: 400, message: `not faked: ${route}` } }, 400);
  });

  return {
    api: `${server.url}/compute/v1`,
    disks,
    snapshots,
    vms,
    groups,
    operations,
    seen,
    refusals,
    fail(code: string) {
      failing = code;
    },
    close: server.close,
  };
}

async function setup(fn: (fake: Awaited<ReturnType<typeof fakeCompute>>) => Promise<void>) {
  const fake = await fakeCompute();
  try {
    await fn(fake);
  } finally {
    await fake.close();
  }
}

const hostFor = (api: string) => gceHost({ api, token: () => Promise.resolve(TOKEN), backoff: 1 });
const changes = (seen: Seen[]) =>
  seen.filter((s) => s.method !== "GET" && !s.path.endsWith("/wait"));

test("a disk is made in its zone, pd-balanced and labeled, once its operation is done", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    await host.createDisk(here, "cz-disk-1", 10);
    const [made] = changes(fake.seen);
    assertEquals(made.path, "/projects/copilotz-485719/zones/us-central1-a/disks");
    assertEquals(made.body, {
      name: "cz-disk-1",
      sizeGb: "10",
      type: "projects/copilotz-485719/zones/us-central1-a/diskTypes/pd-balanced",
      labels: LABELS,
    });
    assertMatch(made.query.requestId, /^[0-9a-f-]{36}$/);
    // It waited for its zone's operation until it was done.
    const op = [...fake.operations.values()][0];
    assert(op.polls >= op.need);
    assert(
      fake.seen.some((s) =>
        s.path.startsWith("/projects/copilotz-485719/zones/us-central1-a/operations/")
      ),
    );

    await host.deleteDisk(here, "cz-disk-1");
    assertEquals(fake.disks.size, 0);
    // Gone already: done.
    await host.deleteDisk(here, "cz-disk-1");
  });
});

test("a snapshot is kept in the zone's region, a disk is made again from it, and it goes", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    assertEquals(regionOf("us-central1-a"), "us-central1");
    await host.createDisk(here, "cz-disk-2", 10);
    await host.snapshot(here, "cz-disk-2", "cz-snap-2");
    assertEquals(fake.snapshots.get("cz-snap-2"), {
      name: "cz-snap-2",
      labels: LABELS,
      storageLocations: ["us-central1"],
      sourceDisk: "cz-disk-2",
    });
    await host.deleteDisk(here, "cz-disk-2");

    await host.restore(here, "cz-snap-2", "cz-disk-2", 20);
    assertEquals(fake.disks.get("cz-disk-2"), {
      name: "cz-disk-2",
      sizeGb: "20",
      type: "projects/copilotz-485719/zones/us-central1-a/diskTypes/pd-balanced",
      labels: LABELS,
      sourceSnapshot: "projects/copilotz-485719/global/snapshots/cz-snap-2",
    });

    // A snapshot's deletion is a global operation.
    await host.deleteSnapshot(here, "cz-snap-2");
    assertEquals(fake.snapshots.size, 0);
    assert(
      fake.seen.some((s) => s.path.startsWith("/projects/copilotz-485719/global/operations/")),
    );
    await host.deleteSnapshot(here, "cz-snap-2");
  });
});

test("attach names the disk's device; detach finds it, and a detached disk or a gone VM is done", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    fake.vms.set("cz-pool-small-ab12", { disks: [] });
    await host.createDisk(here, "cz-disk-3", 10);
    await host.attach(here, "cz-pool-small-ab12", "cz-disk-3", "computer");
    const attach = changes(fake.seen).at(-1)!;
    assertEquals(
      attach.path,
      "/projects/copilotz-485719/zones/us-central1-a/instances/cz-pool-small-ab12/attachDisk",
    );
    assertEquals(
      attach.body.source,
      "projects/copilotz-485719/zones/us-central1-a/disks/cz-disk-3",
    );
    assertEquals(attach.body.deviceName, "computer");
    assertEquals(attach.body.autoDelete, false);
    assertEquals(fake.vms.get("cz-pool-small-ab12")!.disks.length, 1);

    await host.detach(here, "cz-pool-small-ab12", "cz-disk-3");
    const detach = changes(fake.seen).at(-1)!;
    assertEquals(
      detach.path,
      "/projects/copilotz-485719/zones/us-central1-a/instances/cz-pool-small-ab12/detachDisk",
    );
    assertEquals(detach.query.deviceName, "computer");
    assertEquals(fake.vms.get("cz-pool-small-ab12")!.disks, []);

    // Detached already, and a VM that's gone: nothing to do.
    const before = changes(fake.seen).length;
    await host.detach(here, "cz-pool-small-ab12", "cz-disk-3");
    await host.detach(here, "cz-pool-small-gone", "cz-disk-3", true);
    assertEquals(changes(fake.seen).length, before);
  });
});

test("detach by force deletes a VM that won't let its disk go; without force it's an error", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    const source = `${GOOGLE}/projects/copilotz-485719/zones/us-central1-a/disks/cz-disk-4`;
    fake.vms.set("cz-pool-small-cd34", {
      disks: [{ source, deviceName: "computer" }],
      stuck: true,
    });
    const error = await assertRejects(() => host.detach(here, "cz-pool-small-cd34", "cz-disk-4"));
    assertMatch((error as Error).message, /HTTP 400 The instance doesn't answer/);
    await host.detach(here, "cz-pool-small-cd34", "cz-disk-4", true);
    assertEquals(fake.vms.has("cz-pool-small-cd34"), false);
  });
});

test("a pool says its target and its VMs, every page, leaving out those leaving it", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    fake.groups.set("cz-pool-small", {
      targetSize: 4,
      vms: new Map([
        ["cz-pool-small-a", "NONE"],
        ["cz-pool-small-b", "CREATING"],
        ["cz-pool-small-c", "ABANDONING"],
        ["cz-pool-small-d", "VERIFYING"],
        ["cz-pool-small-e", "DELETING"],
      ]),
    });
    assertEquals(await host.pool(here, "small"), {
      target: 4,
      vms: ["cz-pool-small-a", "cz-pool-small-b", "cz-pool-small-d"],
    });
    assertEquals(
      fake.seen.filter((s) => s.path.endsWith("/listManagedInstances")).length,
      3,
    );

    // Another naming of pools.
    const named = gceHost({
      api: fake.api,
      token: () => Promise.resolve(TOKEN),
      pools: (_placement, size) => ({ group: `cz-pool-${size === "tiny" ? "small" : size}` }),
    });
    assertEquals((await named.pool(here, "tiny")).target, 4);
  });
});

test("resize sets a pool's target; taking a VM abandons it and keeps the target", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    fake.groups.set("cz-pool-small", { targetSize: 0, vms: new Map() });
    await host.resize(here, "small", 2);
    assertEquals(fake.groups.get("cz-pool-small")!.targetSize, 2);
    fake.groups.get("cz-pool-small")!.vms.set("cz-pool-small-a", "NONE");
    fake.groups.get("cz-pool-small")!.vms.set("cz-pool-small-b", "NONE");

    await host.take(here, "small", "cz-pool-small-a");
    const [abandon, resize] = changes(fake.seen).slice(-2);
    assertEquals(
      abandon.path,
      "/projects/copilotz-485719/zones/us-central1-a/instanceGroupManagers/cz-pool-small/abandonInstances",
    );
    assertEquals(abandon.body, { instances: ["zones/us-central1-a/instances/cz-pool-small-a"] });
    assertEquals(resize.query.size, "2");
    // The pool still asks for two free VMs; the one taken isn't one of them.
    assertEquals(await host.pool(here, "small"), { target: 2, vms: ["cz-pool-small-b"] });
  });
});

test("deleting a VM waits for it; one that's gone is done", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    fake.vms.set("cz-pool-small-ef56", { disks: [] });
    await host.deleteVm(here, "cz-pool-small-ef56");
    assertEquals(fake.vms.size, 0);
    await host.deleteVm(here, "cz-pool-small-ef56");
  });
});

test("rate and quota refusals are tried again, with the same requestId; others aren't", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    const refuse = (status: number, reason: string) =>
      Response.json({ error: { code: status, message: reason, errors: [{ reason }] } }, { status });
    fake.refusals.push(
      refuse(429, "rateLimitExceeded"),
      refuse(429, "rateLimitExceeded"),
      refuse(403, "rateLimitExceeded"),
    );
    await host.createDisk(here, "cz-disk-5", 10);
    const tries = fake.seen.filter((s) => s.method === "POST" && s.path.endsWith("/disks"));
    assertEquals(tries.length, 4);
    assertEquals(new Set(tries.map((t) => t.query.requestId)).size, 1);
    assert(fake.disks.has("cz-disk-5"));

    // A refusal that's not about rate: raised at once.
    fake.refusals.push(refuse(403, "forbidden"));
    const error = await assertRejects(() => host.createDisk(here, "cz-disk-6", 10));
    assertMatch((error as Error).message, /HTTP 403 forbidden/);
    assertEquals((error as { status?: number }).status, 403);
    assertEquals(fake.disks.has("cz-disk-6"), false);

    // Retried only so often.
    const few = gceHost({
      api: fake.api,
      token: () => Promise.resolve(TOKEN),
      backoff: 1,
      retries: 1,
    });
    fake.refusals.push(refuse(429, "rateLimitExceeded"), refuse(429, "rateLimitExceeded"));
    await assertRejects(() => few.createDisk(here, "cz-disk-7", 10), Error, "HTTP 429");
  });
});

test("an operation's error is raised, saying what failed", async () => {
  await setup(async (fake) => {
    const host = hostFor(fake.api);
    fake.fail("QUOTA_EXCEEDED");
    const error = await assertRejects(() => host.createDisk(here, "cz-disk-8", 10));
    assertMatch(
      (error as Error).message,
      /insert d failed: QUOTA_EXCEEDED: Quota 'SSD_TOTAL_GB' exceeded/,
    );
    assertEquals((error as { reason?: string }).reason, "QUOTA_EXCEEDED");
  });
});
