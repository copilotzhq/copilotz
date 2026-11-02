/**
 * Cloud computers: the app makes one (its record, its secret, its disk);
 * an agent's work wakes it on a VM from the pool (formatting its disk and
 * connecting with a code the first time); unused past its warm window, its
 * VM goes, and the next work takes another; unused for days, its disk
 * becomes a snapshot, and waking makes the disk again. Its VM's seconds and
 * its storage are metered and priced; pools follow their floor by the hour;
 * only VMs of the app's pools, never taken, connect; a VM nobody renews goes;
 * the pool can be another runtime's (an app of many orgs); and only those
 * who may make cloud computers do, each seeing their own.
 */
import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  manualClock,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { usage, type UsageRecord } from "../../billing/mod.ts";
import {
  cloud,
  type CloudComputer,
  cloudPool,
  type Computer,
  computers,
  type Desk,
  type PoolVm,
  remotePool,
} from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { type Job, WORK } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeCloud } from "./fake-cloud.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const PLACE = { project: "test", zone: "test-a" };
const MIN = 60_000;

/** The app: a fake cloud, its books, an agent with computer tools, and a tool as a turn runs it. */
const app = (host: unknown, cloudSettings: Record<string, unknown> = {}) =>
  definePlugin({
    name: "app",
    adapters: { cloudHost: { fake: host as Record<string, unknown> } },
    resources: {
      cloud: { host: "fake", placements: [PLACE], pool: { floor: [], max: 10 }, ...cloudSettings },
      computers: { approve: [] },
      cost: {
        "cloud/small": { seconds: 0.0385, per: 3600 },
        "cloud/disk": { gbHours: 0.10 / 730, per: 1 },
      },
      price: { "cloud/*": { margin: 0.9 }, "cloud/disk": { margin: 0.5 } },
      shared: { thread: {}, message: {} },
      agents: {
        assistant: { instructions: "Hi.", model: "fake/echo", default: true, tools: ["terminal"] },
      },
    },
    actions: {
      "test.tool": defineAction({
        input: {
          type: "object",
          properties: {
            tool: { type: "string" },
            thread: { type: "string" },
            input: { type: "object" },
          },
        },
        allow: () => true,
        run: (ctx, input) =>
          tools[input.tool!].run(input.input ?? {}, {
            ...ctx,
            agent: "assistant",
            thread: input.thread!,
            trigger: "test",
          } as ToolContext),
      }),
      // What the plugin keeps, for the test to change.
      "test.set": defineAction({
        input: {
          type: "object",
          properties: {
            collection: { type: "string" },
            id: { type: "string" },
            set: { type: "object" },
          },
        },
        run: (ctx, input) =>
          ctx.as().db.collection(input.collection!).updateOne({ _id: input.id! }, {
            $set: input.set!,
          }),
      }),
      // What the plugin keeps, for the test to look at.
      "test.records": defineAction({
        input: { type: "object", properties: { collection: { type: "string" } } },
        run: (ctx, input) => ctx.as().db.collection(input.collection!).find({}),
      }),
    },
  });

async function setup(
  fn: (
    rt: Awaited<ReturnType<typeof createRuntime>>,
    world: ReturnType<typeof fakeCloud>,
    topic: string,
  ) => Promise<void>,
  options: {
    settings?: Record<string, unknown>;
    jobs?: () => Job[];
    booting?: { hold: boolean };
  } = {},
) {
  const topic = `cloud-test.${crypto.randomUUID()}`;
  const world = fakeCloud(topic, { jobs: options.jobs, booting: options.booting });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      usage,
      computers,
      cloud,
      cloudPool,
      app(world.host, options.settings),
    ],
    transports: [{ type: "in-process", config: { topic } }],
    // Time moves only when a test says (no tick fires on its own).
    clock: manualClock(Date.now()),
  });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    await rt.call("org.join", { person: "bob" });
    await fn(rt, world, topic);
  } finally {
    await world.close();
    await rt.close();
  }
}

const recordsOf = <T>(rt: Awaited<ReturnType<typeof createRuntime>>, collection: string) =>
  rt.call<T[]>("test.records", { collection });
const cloudOf = async (rt: Awaited<ReturnType<typeof createRuntime>>, id: string) =>
  (await recordsOf<CloudComputer>(rt, "cloudComputer")).find((r) => r._id === id)!;
const later = (at: string | undefined, ms: number) =>
  new Date(new Date(at ?? Date.now()).getTime() + ms).toISOString();

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 300 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

test("a cloud computer: made, woken by an agent's work, released when idle, cold, destroyed", async () => {
  let jobs: Job[] = [];
  await setup(async (rt, world) => {
    // Made: its record and its disk; asleep, never woken.
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    const made = await cloudOf(rt, id);
    assertEquals([made.state, made.ready, made.disk, made.owner], [
      "asleep",
      false,
      `cz-d-${id}`,
      "ana",
    ]);
    assert(world.disks.has(`cz-d-${id}`), "its disk");
    const [computer] = await rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    assertEquals([computer._id, computer.name, computer.online, computer.approve], [
      id,
      "Small cloud computer",
      false,
      [],
    ]);

    // An agent's command, in Ana's Personal space: it wakes, on a VM the pool grew for it.
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    const tool = (input: Record<string, unknown>) =>
      rt.call<{ stdout?: string } | string>("test.tool", { tool: "terminal", thread, input }, {
        actor: ana,
      });
    assertEquals((await tool({ stdin: "ls" }) as { stdout: string }).stdout, "ran ls");
    const first = world.vms.get("vm-small-1")!;
    assertEquals(first.assigned.length, 1);
    const [assign] = first.assigned;
    assertEquals([assign.computer, assign.device, assign.format], [
      id,
      `/dev/disk/by-id/google-cz-${id}`,
      true,
    ]);
    assertEquals(assign.code?.length, 9, "the first wake connects with a code");
    let rec = await cloudOf(rt, id);
    assertEquals([rec.state, rec.vm, rec.ready], ["awake", "vm-small-1", true]);
    assert(world.disks.get(`cz-d-${id}`)?.state?.startsWith(`${id}.`), "its state on its disk");
    assert(world.calls.includes("take vm-small-1"));
    // Awake, work goes straight through.
    assertEquals((await tool({ stdin: "pwd" }) as { stdout: string }).stdout, "ran pwd");
    assertEquals(first.assigned.length, 1);

    // Within its warm window it stays; a job it doesn't keep keeps it past that.
    assertEquals(
      (await rt.call<{ released: string[] }>("cloud.tick", {
        now: later(rec.used, 5 * MIN),
      })).released,
      [],
    );
    jobs = [{ id: "j1", running: true, keep: false } as Job];
    assertEquals(
      (await rt.call<{ released: string[] }>("cloud.tick", {
        now: later(rec.used, 11 * MIN),
      })).released,
      [],
    );
    // A server it keeps (started again on its next wake) doesn't.
    jobs = [{ id: "j2", running: true, keep: true } as Job];
    rec = await cloudOf(rt, id);
    const releasedAt = later(rec.used, 12 * MIN);
    assertEquals(
      (await rt.call<{ released: string[] }>("cloud.tick", {
        now: releasedAt,
      })).released,
      [id],
    );
    rec = await cloudOf(rt, id);
    assertEquals([rec.state, rec.vm], ["asleep", undefined]);
    assert(world.calls.includes(`detach vm-small-1 cz-d-${id}`), "detached, not by force");
    assert(world.calls.includes("deleteVm vm-small-1"), "its VM is deleted");
    assert(!world.vms.has("vm-small-1"));
    await until(
      async () => !(await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0].online,
      "it went",
    );

    // Its VM's seconds, metered and priced (ten times the cost).
    const vmUses = await rt.query<UsageRecord[]>("usage.list", {
      filter: { subject: "cloud/small" },
    });
    const seconds = vmUses.reduce((sum, u) => sum + (u.quantities.seconds ?? 0), 0);
    assertAlmostEquals(seconds, 12 * 60 + 1, 3);
    for (const u of vmUses) {
      assertEquals([u.meter, u.tags?.computer, u.tags?.person], ["computer", id, "ana"]);
      assertAlmostEquals(u.cost!, u.quantities.seconds! * 0.0385 / 3600, 1e-6);
      assertAlmostEquals(u.price!, u.cost! * 10, 1e-6);
    }

    // The next command wakes it on another VM: its disk has its state, so no code, no format.
    assertEquals((await tool({ stdin: "ls" }) as { stdout: string }).stdout, "ran ls");
    rec = await cloudOf(rt, id);
    assert(rec.vm && rec.vm !== "vm-small-1", "a new VM");
    const second = world.vms.get(rec.vm)!;
    assertEquals([second.assigned[0].format, second.assigned[0].code], [undefined, undefined]);

    // Released again, then unused for a week: storage metered, then cold.
    await rt.call("cloud.release", { computer: id });
    const daily = await rt.call<{ cold: string[] }>("cloud.daily", {
      now: later(undefined, 8 * 24 * 60 * MIN),
    });
    assertEquals(daily.cold, [id]);
    rec = await cloudOf(rt, id);
    assertEquals(rec.state, "cold");
    assert(rec.snapshot && world.snapshots.has(rec.snapshot), "its snapshot");
    assert(!world.disks.has(`cz-d-${id}`), "its disk is gone");
    const [disk] = await rt.query<UsageRecord[]>("usage.list", {
      filter: { subject: "cloud/disk" },
    });
    assertAlmostEquals(disk.quantities.gbHours!, 10 * 8 * 24, 1);
    assertAlmostEquals(disk.cost!, disk.quantities.gbHours! * 0.10 / 730, 1e-6);
    assertAlmostEquals(disk.price!, disk.cost! * 2, 1e-6);

    // Waking from cold makes its disk again from the snapshot, which then goes.
    const snapshot = rec.snapshot;
    assertEquals((await tool({ stdin: "ls" }) as { stdout: string }).stdout, "ran ls");
    rec = await cloudOf(rt, id);
    assertEquals([rec.state, rec.snapshot], ["awake", undefined]);
    assert(world.calls.includes(`restore ${snapshot} cz-d-${id}`));
    assert(!world.snapshots.has(snapshot), "the snapshot goes once restored");

    // Destroyed: released, its disk deleted, the computer forgotten.
    assertEquals(await rt.call("cloud.destroy", { computer: id }, { actor: ana }), {
      destroyed: true,
    });
    assert(!world.disks.has(`cz-d-${id}`));
    assertEquals(await rt.query("computer.mine", {}, { actor: ana }), []);
    assertEquals(await recordsOf(rt, "cloudComputer"), []);
  }, { jobs: () => jobs });
});

test("pool VMs connect only from the app's pools; one serving a computer, again as itself until released", async () => {
  await setup(async (rt, world) => {
    const refused = async (w: { ready: Promise<unknown>; stop(): Promise<void> }) => {
      const no = await w.ready.then(() => false, () => true);
      await w.stop().catch(() => {});
      return no;
    };
    assert(await refused(world.stranger()), "a token nobody issued");
    assert(await refused(world.outsider().worker), "a VM outside the app's placements");

    // One of the pool's connects, free, and a wake takes it.
    await rt.call("pool.tick", {});
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    await rt.call("cloud.wake", { computer: id });
    const vmOf = async (name: string) =>
      (await recordsOf<PoolVm>(rt, "poolVm")).find((vm) => vm._id === name)!;
    const taken = (await recordsOf<PoolVm>(rt, "poolVm")).find((vm) => vm.computer === id)!;
    assertEquals(taken.state, "assigned");

    // Its pool connection drops (Cloud Run ends sockets hourly) and comes back: still its computer's.
    await world.vms.get(taken._id)!.worker.stop();
    const back = world.again(taken._id);
    await back.ready;
    assertEquals([(await vmOf(taken._id)).state, (await vmOf(taken._id)).computer], [
      "assigned",
      id,
    ]);
    // It's told to stop serving only its own computer.
    const other = await rt.call("pool.stop", { vm: taken._id, computer: "another" })
      .then(() => undefined, (error) => (error as { code?: string }).code);
    assertEquals(other, "invalid");
    // Told to stop (it answers, over that connection), it never connects again, though it's there.
    assertEquals(await rt.call("pool.stop", { vm: taken._id, computer: id }), { ok: true });
    assert(world.vms.has(taken._id));
    assert(await refused(world.again(taken._id)), "a VM once released");
    // Released: it answers again (no force), then it's deleted.
    await rt.call("cloud.release", { computer: id });
    assert(world.calls.includes(`detach ${taken._id} cz-d-${id}`), "detached, not by force");
    assert(!world.vms.has(taken._id));
    await back.stop();
    // Nobody but the system reads pool VMs.
    const read = await rt.query("cloudComputer.mine", {}, { actor: bob });
    assertEquals(read, []);
  });
});

test("pools keep their floor by the hour, plus the wakes of the last minutes, up to max", async () => {
  await setup(async (rt, world) => {
    const target = async (size: string) => (await world.host.pool(PLACE, size)).target;
    await rt.call("pool.tick", { now: "2026-11-02T10:00:00.000Z" });
    assertEquals([await target("small"), await target("standard")], [2, 0]);
    await rt.call("pool.tick", { now: "2026-11-02T22:30:00.000Z" });
    assertEquals([await target("small"), await target("standard")], [0, 0]);
    // A wake just now: one more expected; never past max.
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    await rt.call("cloud.wake", { computer: id });
    const now = (await cloudOf(rt, id)).woke!;
    const { pools } = await rt.call<{ pools: Record<string, number> }>("pool.tick", { now });
    const hour = new Date(now).getUTCHours();
    const floor = hour >= 9 && hour < 21 ? 2 : 0;
    assertEquals(pools["test-a/small"], floor + 1);
    await rt.call("cloud.release", { computer: id });
  }, {
    settings: {
      pool: { floor: [{ from: 9, to: 21, tz: "UTC", count: 2, size: "small" }], max: 3 },
    },
  });
  await setup(async (rt, world) => {
    await rt.call("pool.tick", { now: "2026-11-02T03:00:00.000Z" });
    assertEquals((await world.host.pool(PLACE, "small")).target, 3, "capped at max");
  }, { settings: { pool: { floor: [{ from: 22, to: 6, count: 5 }], max: 3 } } });
});

test("a pool grown for a wake isn't shrunk while its VM boots", async () => {
  const booting = { hold: true };
  await setup(async (rt, world) => {
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    const woke = rt.call("cloud.wake", { computer: id });
    await until(async () => (await world.host.pool(PLACE, "small")).target === 1, "grown for it");
    // The minute's sizing comes while its VM boots: the pool keeps it.
    const { pools } = await rt.call<{ pools: Record<string, number> }>("pool.tick", {});
    assertEquals(pools["test-a/small"], 1);
    assertEquals((await world.host.pool(PLACE, "small")).target, 1);
    booting.hold = false;
    await world.boot(PLACE, "small");
    assertEquals(await woke, { state: "awake" });
    // Its want went with its take.
    assertEquals(await recordsOf(rt, "poolWant"), []);
    await rt.call("cloud.release", { computer: id });
  }, { booting });
});

test("who makes cloud computers, and who sees them", async () => {
  await setup(async (rt) => {
    // Members don't, by default; owners and admins do: the sizes offered say so, and why.
    type Offer = { create: boolean; why?: string; warmMinutes: number; viewMinutes: number };
    const offer = (actor: Actor) => rt.query<Offer>("cloudComputer.sizes", {}, { actor });
    const forAna = await offer(ana);
    assertEquals([forAna.create, forAna.why, forAna.warmMinutes, forAna.viewMinutes], [
      true,
      undefined,
      10,
      120,
    ]);
    assertEquals([(await offer(bob)).create, (await offer(bob)).why], [false, "admins"]);
    assertEquals(await rt.call("cloud.may", {}, { actor: bob }), { create: false, why: "admins" });
    const refused = await rt.call("cloud.create", { size: "small" }, { actor: bob })
      .then(() => "made", (error) => (error as { code?: string }).code);
    assertEquals(refused, "forbidden");
    const { computer: anas } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    const unknown = await rt.call("cloud.create", { size: "huge" }, { actor: ana })
      .then(() => "made", (error) => (error as { code?: string }).code);
    assertEquals(unknown, "invalid");
    // Each sees their own; the org's owner sees everyone's.
    assertEquals(
      (await rt.query<CloudComputer[]>("cloudComputer.mine", {}, { actor: ana })).map((c) => c._id),
      [anas],
    );
    assertEquals(await rt.query("cloudComputer.mine", {}, { actor: bob }), []);
    const bobSees = await rt.call<{ computers: unknown[]; all: boolean }>("cloud.org", {}, {
      actor: bob,
    });
    assertEquals([bobSees.computers.length, bobSees.all], [0, false]);
    const anaSees = await rt.call<{ computers: unknown[]; all: boolean }>("cloud.org", {}, {
      actor: ana,
    });
    assertEquals([anaSees.computers.length, anaSees.all], [1, true]);
    // Nobody else destroys hers.
    const kept = await rt.call("cloud.destroy", { computer: anas }, { actor: bob })
      .then(() => "destroyed", (error) => (error as { code?: string }).code);
    assert(kept === "forbidden" || kept === "not_found", `bob can't: ${kept}`);
    // Nobody outside calls the system's Actions.
    const woken = await rt.call("cloud.wake", { computer: anas }, { actor: ana })
      .then(() => "woke", (error) => (error as { code?: string }).code);
    assertEquals(woken, "forbidden");
  });
  await setup(async (rt) => {
    // Opened to members: Bob makes one, and sees it.
    const { computer } = await rt.call<{ computer: string }>("cloud.create", {
      size: "standard",
      name: "Bob's box",
    }, { actor: bob });
    const [mine] = await rt.query<CloudComputer[]>("cloudComputer.mine", {}, { actor: bob });
    assertEquals([mine._id, mine.size], [computer, "standard"]);
    const [named] = await rt.query<Computer[]>("computer.mine", {}, { actor: bob });
    assertEquals(named.name, "Bob's box");
    assertEquals(
      (await rt.query<{ create: boolean }>("cloudComputer.sizes", {}, { actor: bob })).create,
      true,
    );
  }, { settings: { create: "members" } });
  await setup(async (rt) => {
    // This month's budget spent (none, here): nobody makes more, owners neither.
    const refused = await rt.call("cloud.create", { size: "small" }, { actor: ana })
      .then(() => "made", (error) => (error as { code?: string }).code);
    assertEquals(refused, "budget");
    const offered = await rt.query<{ create: boolean; why?: string }>("cloudComputer.sizes", {}, {
      actor: ana,
    });
    assertEquals([offered.create, offered.why], [false, "budget"]);
  }, { settings: { budgetUsd: 0 } });
});

test("a cloud computer shared into a space: its members see how it is, on its desk there", async () => {
  await setup(async (rt) => {
    const { computer } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    await join(rt, space, bob, "editor", ana);
    await rt.call("computer.share", { computer, in: space }, { actor: ana });
    await rt.idle();
    const status = async () => {
      const desks = await rt.query<Desk[]>("desk.here", { in: space }, { actor: bob });
      return desks.find((d) => d.computer === computer)?.status;
    };
    // Bob, a member, sees how Ana's is, not only that it's offline.
    assertEquals(await status(), { kind: "cloud", state: "asleep", size: "small" });
    // Woken (by Bob's own work there), it's awake on every desk of it.
    const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: bob });
    await rt.call("computer.work", { desk: desk._id, work: "wake" }, { actor: bob });
    await rt.idle();
    assertEquals((await status())?.state, "awake");
    // Nobody outside the system marks a computer.
    const marked = await rt.call("computer.mark", {
      computer,
      status: { kind: "cloud", state: "awake" },
    }, { actor: bob }).then(() => "marked", (error) => (error as { code?: string }).code);
    assertEquals(marked, "forbidden");
  });
});

test("sizes are offered with their price an hour, and storage's per GB-month", async () => {
  await setup(async (rt) => {
    const offered = await rt.query<{
      sizes: { id: string; label: string; hour: number | null }[];
      disk: { gb: number; gbMonth: number | null; snapshotGbMonth: number | null };
    }>("cloudComputer.sizes", {}, { actor: ana });
    assertEquals(offered.sizes.map((s) => [s.id, s.label]), [
      ["small", "Small"],
      ["standard", "Standard"],
    ]);
    assertAlmostEquals(offered.sizes[0].hour!, 0.385, 1e-9);
    // No cost for standard in this app's book: nothing prices it.
    assertEquals(offered.sizes[1].hour, null);
    assertEquals(offered.disk.gb, 10);
    assertAlmostEquals(offered.disk.gbMonth!, 0.2, 1e-9);
    assertEquals(offered.disk.snapshotGbMonth, null);
  });
});

test("a computer whose VM died is woken again on another, its disk detached by force", async () => {
  await setup(async (rt, world) => {
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    await rt.call("cloud.wake", { computer: id });
    const dead = (await cloudOf(rt, id)).vm!;
    // The VM dies: its computer and pool connection go, without releasing.
    const vm = world.vms.get(dead)!;
    await vm.computer!.worker.stop();
    await vm.worker.stop();
    await until(
      async () => !(await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0].online,
      "it went",
    );
    assertEquals(await rt.call("cloud.wake", { computer: id }), { state: "awake" });
    const rec = await cloudOf(rt, id);
    assert(rec.vm && rec.vm !== dead, "another VM");
    assert(world.calls.includes(`detach ${dead} cz-d-${id} force`), "detached by force");
    assert(world.calls.includes(`deleteVm ${dead}`));
    // Not a cloud computer: nothing to wake.
    assertEquals(await rt.call("cloud.wake", { computer: "a-laptop" }), null);
    assertStringIncludes(id, "-");
  });
});

test("a VM's seconds stop at its lease: an org closed for days isn't charged for a VM that was gone", async () => {
  await setup(async (rt) => {
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    await rt.call("cloud.wake", { computer: id });
    const { woke } = await cloudOf(rt, id);
    await rt.call("cloud.tick", { now: later(woke, 5 * MIN) });
    // Nothing ticks for three days (the org closed), and its VM went with its lease long ago.
    await rt.call("cloud.release", { computer: id, force: true, now: later(woke, 3 * 1440 * MIN) });
    const seconds = (await recordsOf<UsageRecord>(rt, "usage"))
      .filter((r) => r.subject === "cloud/small")
      .reduce((sum, r) => sum + (r.quantities.seconds ?? 0), 0);
    assertEquals(seconds, 15 * 60, "the 5 minutes ticked, and at most its lease after them");
  });
});

test("a VM nobody renews goes once its lease runs out; one its computer uses is renewed", async () => {
  await setup(async (rt, world) => {
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    await rt.call("cloud.wake", { computer: id });
    const vm = (await cloudOf(rt, id)).vm!;
    const pooled = async () => (await recordsOf<PoolVm>(rt, "poolVm")).find((v) => v._id === vm)!;
    const { taken, until: leased } = await pooled();
    assert(taken && leased && leased > taken, "taken, and leased");

    // Its computer is awake (woken 5 minutes ago: still warm), so its VM's lease goes on.
    await rt.call("cloud.tick", { now: later(taken, 5 * MIN) });
    assert((await pooled()).until! > leased, "renewed");
    const kept = await rt.call<{ lapsed: string[] }>("pool.tick", { now: later(taken, 12 * MIN) });
    assertEquals(kept.lapsed, []);
    assert(world.vms.has(vm));

    // Nobody renews it: past its lease, it's deleted, and its disk stays.
    const lapsed = await rt.call<{ lapsed: string[] }>("pool.tick", {
      now: later(taken, 16 * MIN),
    });
    assertEquals(lapsed.lapsed, [vm]);
    assert(world.calls.includes(`deleteVm ${vm}`) && !world.vms.has(vm), "its VM is deleted");
    assertEquals((await pooled()).state, "gone");
    assert(world.disks.has(`cz-d-${id}`), "its disk stays");

    // Its computer, which still says it's awake, wakes again on another VM.
    await until(
      async () => !(await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0].online,
      "it went",
    );
    assertEquals(await rt.call("cloud.wake", { computer: id }), { state: "awake" });
    const again = (await cloudOf(rt, id)).vm;
    assert(again && again !== vm, "another VM");
    await rt.call("cloud.release", { computer: id });
  });
});

test("the pool in a runtime of its own: an org's computers wake and go through remotePool", async () => {
  const poolTopic = `cloud-pool.${crypto.randomUUID()}`;
  const orgTopic = `cloud-org.${crypto.randomUUID()}`;
  // Where the org's computers connect: its own address, its runtime's topic here.
  const orgApp = "http://app.test/o/acme";
  const world = fakeCloud(poolTopic, { topics: { [orgApp]: orgTopic } });
  const clock = manualClock(Date.now());
  // The pool's runtime: nothing but cloudPool, its cloud and its settings (as a directory's).
  const pool = await createRuntime({
    store: memoryStore(),
    plugins: [
      cloudPool,
      definePlugin({
        name: "pool-app",
        adapters: { cloudHost: { fake: world.host } },
        resources: {
          cloud: {
            host: "fake",
            placements: [PLACE],
            pool: { floor: [{ from: 0, to: 24, count: 1, size: "small" }], max: 3 },
            audience: "http://app.test",
          },
        },
        actions: {
          "test.records": defineAction({
            input: { type: "object", properties: { collection: { type: "string" } } },
            run: (ctx, input) => ctx.as().db.collection(input.collection!).find({}),
          }),
        },
      }),
    ],
    transports: [{ type: "in-process", config: { topic: poolTopic } }],
    clock,
  });
  const forwarded: string[] = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      usage,
      computers,
      cloud,
      remotePool((action, input) => {
        forwarded.push(action);
        return pool.call(action, input);
      }, "acme"),
      app(world.host),
      definePlugin({ name: "org-address", resources: { computers: { url: orgApp } } }),
    ],
    transports: [{ type: "in-process", config: { topic: orgTopic } }],
    clock: manualClock(Date.now()),
  });
  const vmsOf = () => pool.call<PoolVm[]>("test.records", { collection: "poolVm" });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });

    // Its own schedule keeps the pool's floor: a free VM connects to it.
    clock.advance(61_000);
    await until(async () => (await vmsOf()).some((v) => v.state === "free"), "a free VM");
    assert(world.calls.includes("resize small 1"));

    // An org's computer wakes on it: taken for the org, served, connected to the org's runtime.
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    assertEquals(await rt.call("cloud.wake", { computer: id }), { state: "awake" });
    const vm = (await cloudOf(rt, id)).vm!;
    const taken = (await vmsOf()).find((v) => v._id === vm)!;
    assertEquals([taken.state, taken.computer, taken.org], ["assigned", id, "acme"]);
    assertEquals(world.vms.get(vm)!.assigned[0].app, orgApp);
    assertEquals((await rt.query<Computer[]>("computer.mine", {}, { actor: ana }))[0].online, true);
    assertEquals(forwarded.slice(0, 2), ["pool.take", "pool.serve"]);

    // Its ticks renew the VM's lease, at the pool.
    await rt.call("cloud.tick", { now: later(taken.taken, 5 * MIN) });
    assert(forwarded.includes("pool.renew"));
    assert((await vmsOf()).find((v) => v._id === vm)!.until! > taken.until!, "renewed");

    // A VM another org has isn't this one's to touch.
    const other = (await vmsOf()).find((v) => v._id !== vm)!;
    const refused = await pool.call("pool.drop", { vm: other._id, org: "other" })
      .then(() => undefined, (error) => (error as { code?: string }).code);
    assertEquals(refused, "not_found");

    // Released: told to stop, its disk detached, the VM deleted, at the pool.
    await rt.call("cloud.release", { computer: id });
    assert(forwarded.includes("pool.stop") && forwarded.includes("pool.drop"));
    assert(world.calls.includes(`detach ${vm} cz-d-${id}`), "detached, not by force");
    assert(!world.vms.has(vm), "its VM is deleted");
    assertEquals((await vmsOf()).find((v) => v._id === vm)!.state, "gone");
  } finally {
    await world.close();
    await rt.close();
    await pool.close();
  }
});

test("a person's panel: reading neither wakes a cloud computer nor keeps it awake; wake and work do", async () => {
  await setup(async (rt) => {
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    const [desk] = await rt.query<{ _id: string }[]>("desk.here", { in: space }, { actor: ana });
    const work = (what: string, input: Record<string, unknown> = {}) =>
      rt.call("computer.work", { desk: desk._id, work: what, input }, { actor: ana });

    // Asleep, a panel polling its jobs doesn't wake it: the computer is offline.
    await assertRejects(() => work("jobs.list", { all: true }));
    assertEquals((await cloudOf(rt, id)).state, "asleep");

    // Its page opened: it wakes.
    assertEquals(await work("wake"), { awake: true });
    assertEquals((await cloudOf(rt, id)).state, "awake");

    // Reading doesn't say it was used; a command does.
    const before = new Date(Date.now() - MIN).toISOString();
    await rt.call("test.set", { collection: "cloudComputer", id, set: { used: before } });
    await work("jobs.list", { all: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals((await cloudOf(rt, id)).used, before);
    await work("terminal", { stdin: "ls" });
    await until(async () => (await cloudOf(rt, id)).used !== before, "used, by the command");
  });
});

test("an agent names an asleep cloud computer when the default is a person's: it wakes, and works there", async () => {
  await setup(async (rt, world, topic) => {
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
      name: "builder",
    }, { actor: ana });
    const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
    // Ana's own machine joins the space, and is made its default.
    const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
    const laptop = fakeComputer(topic, `code:${code}`, { info: { hostname: "laptop" } });
    await laptop.worker.ready;
    let desks: { _id: string; name?: string; online: boolean }[] = [];
    await until(async () => {
      desks = await rt.query("desk.here", { in: space }, { actor: ana });
      return desks.some((d) => d.name === "laptop" && d.online);
    }, "the laptop came");
    await rt.call("computer.default", { desk: desks.find((d) => d.name === "laptop")!._id }, {
      actor: ana,
    });
    const { thread } = await rt.call<{ thread: string }>("chat.send", {
      text: "hello",
      in: space,
    }, { actor: ana });
    await rt.idle();
    const tool = (input: Record<string, unknown>) =>
      rt.call<{ stdout?: string } | string>("test.tool", { tool: "terminal", thread, input }, {
        actor: ana,
      });
    try {
      // The default: the laptop. The cloud computer sleeps on.
      assertEquals((await tool({ stdin: "ls" }) as { stdout: string }).stdout, "ran ls");
      assertEquals((await cloudOf(rt, id)).state, "asleep");
      // Named, it wakes (its pool grows for it), and the command runs there.
      assertEquals(
        (await tool({ stdin: "make", computer: "Builder" }) as { stdout: string }).stdout,
        "ran make",
      );
      const rec = await cloudOf(rt, id);
      assertEquals(rec.state, "awake");
      assert(world.vms.get(rec.vm!)!.assigned.some((a) => a.computer === id));
      assertEquals(
        laptop.asked.filter((a) => a.work === WORK.terminal).map((a) => a.input.stdin),
        ["ls"],
      );
      await rt.call("cloud.release", { computer: id });
    } finally {
      await laptop.worker.stop().catch(() => {});
    }
  });
});
