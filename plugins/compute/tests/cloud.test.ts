/**
 * Cloud computers: the app makes one (its record, its secret, its disk);
 * an agent's work wakes it on a VM from the pool (formatting its disk and
 * connecting with a code the first time); unused past its warm window, its
 * VM goes, and the next work takes another; unused for days, its disk
 * becomes a snapshot, and waking makes the disk again. Its VM's seconds and
 * its storage are metered and priced; pools follow their floor by the hour;
 * only VMs of the app's pools, never taken, connect; and only those who may
 * make cloud computers do, each seeing their own.
 */
import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
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
import { usage, type UsageRecord } from "../../billing/mod.ts";
import { cloud, type CloudComputer, type Computer, computers, type PoolVm } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import type { Job } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeCloud } from "./fake-cloud.ts";

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
  ) => Promise<void>,
  options: { settings?: Record<string, unknown>; jobs?: () => Job[] } = {},
) {
  const topic = `cloud-test.${crypto.randomUUID()}`;
  const world = fakeCloud(topic, { jobs: options.jobs });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, usage, computers, cloud, app(world.host, options.settings)],
    transports: [{ type: "in-process", config: { topic } }],
    // Time moves only when a test says (no tick fires on its own).
    clock: manualClock(Date.now()),
  });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    await rt.call("org.join", { person: "bob" });
    await fn(rt, world);
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
    assertEquals([computer._id, computer.name, computer.online], [
      id,
      "Small cloud computer",
      false,
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

test("pool VMs connect only from the app's pools, and never again once taken", async () => {
  await setup(async (rt, world) => {
    const refused = async (w: { ready: Promise<unknown>; stop(): Promise<void> }) => {
      const no = await w.ready.then(() => false, () => true);
      await w.stop().catch(() => {});
      return no;
    };
    assert(await refused(world.stranger()), "a token nobody issued");
    assert(await refused(world.outsider().worker), "a VM outside the app's placements");

    // One of the pool's connects, free; taken by a wake, its own token no longer gets in.
    await rt.call("cloud.tick", {});
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    await rt.call("cloud.wake", { computer: id });
    const vms = await recordsOf<PoolVm>(rt, "poolVm");
    const taken = vms.find((vm) => vm.computer === id)!;
    assertEquals(taken.state, "assigned");
    assert(await refused(world.again(taken._id)), "a VM once taken");
    // Nobody but the system reads pool VMs.
    const read = await rt.query("cloudComputer.mine", {}, { actor: bob });
    assertEquals(read, []);
  });
});

test("pools keep their floor by the hour, plus the wakes of the last minutes, up to max", async () => {
  await setup(async (rt, world) => {
    const target = async (size: string) => (await world.host.pool(PLACE, size)).target;
    await rt.call("cloud.tick", { now: "2026-11-02T10:00:00.000Z" });
    assertEquals([await target("small"), await target("standard")], [2, 0]);
    await rt.call("cloud.tick", { now: "2026-11-02T22:30:00.000Z" });
    assertEquals([await target("small"), await target("standard")], [0, 0]);
    // A wake just now: one more expected; never past max.
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    await rt.call("cloud.wake", { computer: id });
    const now = (await cloudOf(rt, id)).woke!;
    const { pools } = await rt.call<{ pools: Record<string, number> }>("cloud.tick", { now });
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
    await rt.call("cloud.tick", { now: "2026-11-02T03:00:00.000Z" });
    assertEquals((await world.host.pool(PLACE, "small")).target, 3, "capped at max");
  }, { settings: { pool: { floor: [{ from: 22, to: 6, count: 5 }], max: 3 } } });
});

test("who makes cloud computers, and who sees them", async () => {
  await setup(async (rt) => {
    // Members don't, by default; owners and admins do.
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
  }, { settings: { create: "members" } });
  await setup(async (rt) => {
    // This month's budget spent (none, here): nobody makes more, owners neither.
    const refused = await rt.call("cloud.create", { size: "small" }, { actor: ana })
      .then(() => "made", (error) => (error as { code?: string }).code);
    assertEquals(refused, "budget");
  }, { settings: { budgetUsd: 0 } });
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
