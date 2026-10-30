/**
 * A cloud computer end to end, with the real pieces: the app served over
 * WebSocket, the local cloud (its disks folders), and each of its VMs the
 * computer program in pool mode (in this process). An agent's command wakes
 * the computer (its disk formatted, enrolled with a code), runs in a real
 * shell on its disk; a job it doesn't keep holds its VM past the warm
 * window; released, its next command runs on another VM, its files still
 * there; destroyed, its disk goes.
 */
import { assert, assertEquals } from "@std/assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, defineAction, definePlugin, manualClock } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat, type ToolContext } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { cloud, type CloudComputer, computers, type Desk, localHost } from "../mod.ts";
import { tools } from "../computers/resources/tools.ts";
import { type Pool, startPool } from "../computers/program/pool.ts";
import type { Job, TerminalResult } from "../computers/shared/workloads.ts";
import { host, tempDir, test } from "../../../testing/mod.ts";

const ana = { kind: "person", id: "ana" } as const;
const MIN = 60_000;

test({
  name:
    "a cloud computer on the local cloud, with the real program: woken, used, released, woken again",
  // The program's shell is bash.
  ignore: (globalThis as { process?: { platform?: string } }).process?.platform === "win32",
  fn: async () => {
    const dir = tempDir();
    const pools: Pool[] = [];
    // Where VMs connect: the app's socket, once it's served.
    let url = "";
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
              // Each VM: the program in pool mode, in this process, connecting over the socket.
              local: localHost({
                dir,
                launch: async ({ name, token }) => {
                  const pool = await startPool({
                    app: url,
                    vm: name,
                    token,
                    root: tempDir(),
                    computer: { chromium: null },
                    log: () => {},
                  });
                  pools.push(pool);
                  return { stop: () => pool.stop() };
                },
              }),
            },
          },
          resources: {
            cloud: { pool: { floor: [], max: 3 } },
            computers: { approve: [] },
            shared: { thread: {}, message: {} },
            agents: {
              assistant: {
                instructions: "Hi.",
                model: "fake/echo",
                default: true,
                tools: ["terminal"],
              },
            },
          },
          actions: {
            "test.tool": defineAction({
              input: { type: "object", properties: { thread: {}, input: {} } },
              allow: () => true,
              run: (ctx, input) =>
                tools.terminal.run(input.input as Record<string, unknown>, {
                  ...ctx,
                  agent: "assistant",
                  thread: input.thread as string,
                  trigger: "test",
                } as ToolContext),
            }),
          },
        }),
      ],
      transports: [{ type: "websocket", config: { path: "/oxian" } }],
      clock: manualClock(Date.now()),
    });
    const listener = await host(rt.hypervisor);
    try {
      url = `http://127.0.0.1:${new URL(String(listener.url)).port}`;
      await rt.call("org.join", { person: "ana", role: "owner" });
      const { computer: id } = await rt.call<{ computer: string }>("cloud.create", {
        size: "small",
      }, { actor: ana });
      const disk = join(dir, "app", "local", "local", "disks", `cz-d-${id}`);
      const { space } = await rt.call<{ space: string }>("space.personal", {}, { actor: ana });
      const { thread } = await rt.call<{ thread: string }>("chat.send", {
        text: "hello",
        in: space,
      }, { actor: ana });
      await rt.idle();
      const run = async (stdin: string) => {
        const answer = await rt.call<TerminalResult | string>("test.tool", {
          thread,
          input: { stdin },
        }, { actor: ana });
        assert(typeof answer === "object", `ran: ${answer}`);
        return answer.stdout;
      };

      // The agent's command wakes it: its disk formatted, enrolled, its state on the disk.
      assertEquals(await run("echo hello > a.txt && cat a.txt"), "hello\n");
      assert(existsSync(join(disk, ".copilotz", "computer.json")), "its state, on its disk");
      assertEquals(readFileSync(join(disk, "spaces", "personal", "a.txt"), "utf8"), "hello\n");
      let [rec] = await rt.query<CloudComputer[]>("cloudComputer.mine", {}, { actor: ana });
      assertEquals([rec.state, rec.ready], ["awake", true]);
      const first = rec.vm;

      // A job it doesn't keep holds its VM past the warm window; stopped, the VM goes.
      const [desk] = await rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
      const job = await rt.call<Job>("computer.work", {
        desk: desk._id,
        work: "jobs.start",
        input: { command: "sleep 30", name: "build" },
      }, { actor: ana });
      const idle = later(rec.used!, 11 * MIN);
      assertEquals(
        (await rt.call<{ released: string[] }>("cloud.tick", { now: idle })).released,
        [],
      );
      await rt.call("computer.work", {
        desk: desk._id,
        work: "jobs.stop",
        input: { id: job.id },
      }, { actor: ana });
      [rec] = await rt.query<CloudComputer[]>("cloudComputer.mine", {}, { actor: ana });
      assertEquals(
        (await rt.call<{ released: string[] }>("cloud.tick", { now: later(rec.used!, 11 * MIN) }))
          .released,
        [id],
      );

      // Its next command runs on another VM, as itself, its files still there.
      assertEquals(await run("cat a.txt"), "hello\n");
      [rec] = await rt.query<CloudComputer[]>("cloudComputer.mine", {}, { actor: ana });
      assert(rec.vm && rec.vm !== first, "another VM");

      // Destroyed: released, its disk gone.
      await rt.call("cloud.destroy", { computer: id }, { actor: ana });
      assert(!existsSync(disk), "its disk is gone");
    } finally {
      await Promise.all(pools.map((pool) => pool.stop().catch(() => {})));
      await listener.shutdown();
      await rt.close();
    }
  },
});

const later = (at: string, ms: number) => new Date(new Date(at).getTime() + ms).toISOString();
