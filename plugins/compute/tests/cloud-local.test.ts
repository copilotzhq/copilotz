/**
 * The local cloud (`host: "local"`): disks are folders, snapshots copies of
 * them, VMs whatever its launcher starts (here, in-process pool workers);
 * pools keep as many as asked, taking one starts another; attaching gives
 * the VM the disk's folder; only its own tokens verify. And a cloud computer
 * on it, end to end: made, woken (its state written in its folder), released,
 * woken again as itself.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, definePlugin, manualClock } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { cloud, type CloudComputer, computers, createLocalHost, type LocalLaunch } from "../mod.ts";
import { tempDir, test } from "../../../testing/mod.ts";
import { fakePoolProgram } from "./fake-cloud.ts";

const PLACE = { project: "local", zone: "local" };

test("the local cloud: folders for disks, copies for snapshots, launched VMs, its own tokens", async () => {
  const dir = tempDir();
  const launched: { name: string; token: string; stopped: boolean }[] = [];
  const launch: LocalLaunch = ({ name, token }) => {
    const vm = { name, token, stopped: false };
    launched.push(vm);
    return { stop: () => void (vm.stopped = true) };
  };
  const host = createLocalHost({ dir, launch });

  // A disk is a folder; a snapshot, a copy; restored, the disk is back as it was.
  await host.createDisk(PLACE, "cz-d-one", 10);
  const disk = join(dir, "app", "local", "local", "disks", "cz-d-one");
  writeFileSync(join(disk, "computer.json"), '{"id":"one"}');
  await assertRejects(() => host.createDisk(PLACE, "cz-d-one", 10));
  await host.snapshot(PLACE, "cz-d-one", "cz-s-one-1");
  await host.deleteDisk(PLACE, "cz-d-one");
  assert(!existsSync(disk));
  await host.restore(PLACE, "cz-s-one-1", "cz-d-one", 10);
  assertEquals(readFileSync(join(disk, "computer.json"), "utf8"), '{"id":"one"}');
  await host.deleteSnapshot(PLACE, "cz-s-one-1");
  assertEquals(readdirSync(join(dir, "app", "local", "local", "snapshots")), []);
  await assertRejects(() => host.createDisk(PLACE, "../escape", 10));

  // A pool keeps what it's asked; each VM gets a token of its own, which only it verifies with.
  await host.resize(PLACE, "small", 2);
  assertEquals(launched.length, 2);
  const { target, vms } = await host.pool(PLACE, "small");
  assertEquals([target, vms.length], [2, 2]);
  const [a] = launched;
  assert(a.token.startsWith(`local:${a.name}.`));
  assertEquals(await host.verify(a.token, ""), { vm: a.name, placement: PLACE });
  assertEquals(await host.verify(`local:${a.name}.0000`, ""), null);
  assertEquals(await host.verify("gce:whatever", ""), null);

  // Taken, a VM leaves its pool, which starts another; attached, it gets the disk's folder.
  await host.take(PLACE, "small", a.name);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(launched.length, 3);
  assert(!(await host.pool(PLACE, "small")).vms.includes(a.name));
  assertEquals(await host.attach(PLACE, a.name, "cz-d-one", "cz-one"), disk);
  await assertRejects(() => host.deleteDisk(PLACE, "cz-d-one"), Error, "attached");
  await host.detach(PLACE, a.name, "cz-d-one");
  await host.deleteVm(PLACE, a.name);
  assert(a.stopped, "deleted, it's stopped");
  assertEquals(await host.verify(a.token, ""), null);
  await host.deleteDisk(PLACE, "cz-d-one");

  // Shrunk, its free VMs stop.
  await host.resize(PLACE, "small", 0);
  assertEquals((await host.pool(PLACE, "small")).vms, []);
  assert(launched.slice(1).every((vm) => vm.stopped));

  // Without the app's address, it can't start the program.
  const bare = createLocalHost({ dir });
  await assertRejects(() => bare.resize(PLACE, "small", 1), Error, "app's address");
});

test("a cloud computer on the local cloud: its state in its folder, woken again as itself", async () => {
  const dir = tempDir();
  const topic = `cloud-local.${crypto.randomUUID()}`;
  const programs: ReturnType<typeof fakePoolProgram>[] = [];
  // Each VM is the program in pool mode, in-process: its disk is the folder it's given.
  const launch: LocalLaunch = ({ token }) => {
    const program = fakePoolProgram(topic, token, (folder) => ({
      read: () =>
        Promise.resolve(
          existsSync(join(folder, "computer.json"))
            ? readFileSync(join(folder, "computer.json"), "utf8")
            : undefined,
        ),
      write: (state) => Promise.resolve(writeFileSync(join(folder, "computer.json"), state)),
      format: () => {
        rmSync(folder, { recursive: true, force: true });
        mkdirSync(folder, { recursive: true });
        return Promise.resolve();
      },
    }));
    programs.push(program);
    return { stop: () => program.stop() };
  };
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      computers,
      cloud,
      definePlugin({
        name: "app",
        adapters: {
          cloudHost: {
            local: (account: string | undefined) => createLocalHost({ dir, launch }, account),
          },
        },
        resources: { cloud: { pool: { floor: [], max: 3 } } },
      }),
    ],
    transports: [{ type: "in-process", config: { topic } }],
    clock: manualClock(Date.now()),
  });
  try {
    await rt.call("org.join", { person: "ana", role: "owner" });
    const ana = { kind: "person", id: "ana" } as const;
    const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
      size: "small",
    }, { actor: ana });
    const folder = join(dir, "app", "local", "local", "disks", `cz-d-${id}`);
    assert(existsSync(folder), "its disk, a folder");
    await rt.call("cloud.wake", { computer: id });
    const [first] = programs;
    assertEquals([first.assigned[0].device, first.assigned[0].format], [folder, true]);
    assert(readFileSync(join(folder, "computer.json"), "utf8").startsWith(`${id}.`));
    await rt.call("cloud.release", { computer: id });
    await rt.call("cloud.wake", { computer: id });
    const again = programs.find((p) => p.assigned.length && p !== first)!;
    assertEquals([again.assigned[0].device, again.assigned[0].code], [folder, undefined]);
    const [rec] = await rt.query<CloudComputer[]>("cloudComputer.mine", {}, { actor: ana });
    assertEquals([rec.state, rec.ready], ["awake", true]);
    await rt.call("cloud.destroy", { computer: id }, { actor: ana });
    assert(!existsSync(folder), "destroyed, its folder goes");
  } finally {
    await rt.close();
    for (const program of programs) await program.stop();
  }
});
