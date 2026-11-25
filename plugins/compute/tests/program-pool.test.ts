/**
 * The program on a pool VM (`computer pool`): it connects to the app as a
 * `pool` worker, by its token or (on Compute Engine) a fresh identity token;
 * assigned a computer (its disk: here, a folder, as the local host gives),
 * it runs it until it's connected, enrolling it the first time with a code;
 * released, it stops it (its kept jobs listed on the disk), and the next
 * wake starts them again. Its work runs in a home on the disk, so a CLI
 * installed there is found on its next wake too. It serves one computer at
 * a time, and never another after.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  type Plugin,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { env, host, runtime, serve, tempDir, test } from "../../../testing/mod.ts";
import { POOL, POOL_KIND, type PoolAssign } from "../computers/shared/pool.ts";
import { offerUpdate } from "../computers/shared/update.ts";
import { VERSION } from "../computers/program/version.ts";
import { audienceOf, type Pool, type PoolOptions, startPool } from "../computers/program/pool.ts";
import { connectionOf, loadState } from "../computers/program/state.ts";
import { alive } from "../computers/program/workloads/processes.ts";
import {
  type EngineStatus,
  type Job,
  type JobsWaited,
  type Scope,
  type TerminalResult,
  WORK,
} from "../computers/shared/workloads.ts";
import { fakeCli } from "./fake-cli.ts";
import { CODE, computers, until } from "./program-setup.ts";

const TOKEN = "local:vm-1.t0ken";
/** The program's pool mode runs on Linux VMs: its tests run where POSIX processes and paths are. */
const POSIX_ONLY = process.platform === "win32";
const JWT = "eyJhbGciOiJSUzI1NiJ9.e30.c2ln";
const scope: Scope = { space: "s", folder: "alpha", who: "agent:a" };
type Failed = { error: { message: string; code: string } };

/** A plugin of the `pool` kind: it knows VMs by their local tokens, and `vm-gce` by its identity. */
const pools = definePlugin({
  name: "pool-test",
  collections: {
    poolPresented: defineCollection({
      schema: { type: "object", properties: { secret: { type: "string" } } },
    }),
  },
  workers: {
    pool: { admit: "pooltest.admit", workloads: Object.values(POOL) },
  },
  actions: {
    "pooltest.admit": defineAction({
      input: { type: "object", properties: { secret: { type: "string" } } },
      run: async (ctx, input) => {
        await ctx.db.collection("poolPresented").insertOne({ secret: input.secret ?? "" });
        const local = /^local:([\w-]+)\.t0ken$/.exec(input.secret ?? "");
        if (local) return { id: local[1] };
        if (input.secret === `gce:${JWT}`) return { id: "vm-gce" };
        return null;
      },
    }),
    "pooltest.presented": defineAction({
      input: { type: "object" },
      run: async (ctx) =>
        (await ctx.db.collection("poolPresented").find({}).toArray()).map((doc) => doc.secret),
    }),
    // Work for a pool VM, as the cloud plugin sends it.
    "pooltest.work": defineAction({
      input: {
        type: "object",
        properties: { vm: { type: "string" }, workload: { type: "string" }, input: {} },
        required: ["vm", "workload"],
      },
      run: (ctx, input) => ctx.workers.call("pool", input.vm, input.workload, input.input),
    }),
  },
});

type App = {
  rt: Awaited<ReturnType<typeof createRuntime>>;
  url: string;
  /** Starts a pool VM on this app (stopped with the rest). */
  pool(options?: Partial<PoolOptions>): Promise<Pool>;
  /** Work for pool VM `vm`. */
  assign(vm: string, input: PoolAssign): Promise<{ ok?: true } & Partial<Failed>>;
  release(vm: string, computer: string): Promise<{ ok?: true } & Partial<Failed>>;
  /** Work for computer `id`, as the computers plugin sends it. */
  work<R = unknown>(id: string, workload: string, input: unknown): Promise<R>;
};

/** Runs `fn` with an app that has both kinds of workers (and `more`); everything stops after. */
async function app(fn: (app: App) => Promise<void>, more: Plugin[] = []) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [computers, pools, ...more],
    transports: [{ type: "websocket", config: { path: "/oxian" } }],
  });
  const listener = await host(rt.hypervisor);
  const url = `http://127.0.0.1:${new URL(String(listener.url)).port}`;
  const started: Pool[] = [];
  try {
    await fn({
      rt,
      url,
      async pool(options = {}) {
        const pool = await startPool({
          app: url,
          vm: "vm-1",
          token: TOKEN,
          root: tempDir(),
          computer: { chromium: null },
          log: () => {},
          ...options,
        });
        started.push(pool);
        return pool;
      },
      assign: (vm, input) =>
        rt.call("pooltest.work", { vm, workload: POOL.assign, input }) as never,
      release: (vm, computer) =>
        rt.call("pooltest.work", { vm, workload: POOL.release, input: { computer } }) as never,
      work: (id, workload, input) => rt.call("test.work", { id, workload, input }) as never,
    });
  } finally {
    await Promise.all(started.map((pool) => pool.stop()));
    await listener.shutdown();
    await rt.close();
  }
}

/** Whether computer `id` answers. */
const answers = (app: App, id: string) =>
  app.work<{ version?: string }>(id, WORK.info, {}).then((info) => !!info?.version, () => false);

test({
  name:
    "a pool VM serves the computer it's given, enrolling it the first time; released, it stops it, and its kept jobs start again on its next wake",
  // Pool VMs are Linux (POSIX) machines.
  ignore: POSIX_ONLY,
  fn: async () => {
    await app(async (app) => {
      const pool = await app.pool();
      await pool.ready;
      assertEquals(pool.vm, "vm-1");
      const disk = tempDir();

      // First wake: a code, and its name.
      const first = await app.assign("vm-1", {
        computer: "c2",
        device: disk,
        code: CODE,
        name: "box",
      });
      assertEquals(first, { ok: true });
      const statePath = join(disk, ".copilotz", "computer.json");
      await until(
        async () => !!connectionOf(await loadState(statePath), app.url)?.secret,
        "enrolled",
      );
      const state = connectionOf(await loadState(statePath), app.url);
      assertEquals([state?.id, state?.root], ["c2", join(realpathSync(disk), "spaces")]);
      const info = await app.work<{ name?: string; root: string }>("c2", WORK.info, {});
      assertEquals(info.name, "box");
      assert(info.root.endsWith("spaces"), info.root);

      // A server it keeps, and a command it doesn't.
      const kept = await app.work<Job>("c2", WORK.jobsStart, {
        scope,
        command: "sleep 30",
        name: "server",
        port: 4321,
        keep: true,
      });
      assertEquals([kept.keep, kept.port], [true, 4321]);
      await app.work<Job>("c2", WORK.jobsStart, { scope, command: "sleep 30", name: "once" });

      // Another computer, while it serves this one: busy.
      const busy = await app.assign("vm-1", { computer: "c1", device: tempDir() });
      assertEquals(busy.error?.code, "busy");
      // Asked again for the same one (its answer was lost): as the first.
      assertEquals(await app.assign("vm-1", { computer: "c2", device: disk }), { ok: true });

      assertEquals(await app.release("vm-1", "c2"), { ok: true });
      await until(async () => !(await answers(app, "c2")), "it disconnected");
      const list = JSON.parse(readFileSync(join(disk, "spaces", ".copilotz", "jobs.json"), "utf8"));
      assertEquals(list, [{
        folder: "alpha",
        who: "agent:a",
        name: "server",
        command: "sleep 30",
        port: 4321,
      }]);
      // Released already: nothing to release.
      assertEquals(await app.release("vm-1", "c2"), { ok: true });

      // Its next wake: as itself (its secret on the disk), its kept job running again.
      assertEquals(await app.assign("vm-1", { computer: "c2", device: disk }), { ok: true });
      const jobs = await app.work<Job[]>("c2", WORK.jobsList, { scope, all: true });
      assertEquals(
        jobs.map((job) => [job.name, job.running, job.keep, job.port]),
        [["server", true, true, 4321]],
      );
      const presented = await app.rt.call<string[]>("test.presented", {});
      assertEquals(presented, [`code:${CODE}`, `c2.${state!.secret}`]);

      // Stopped by whose it is, it's no longer kept.
      await app.work<Job>("c2", WORK.jobsStop, { scope, id: jobs[0].id });
      assertEquals(
        JSON.parse(readFileSync(join(disk, "spaces", ".copilotz", "jobs.json"), "utf8")),
        [],
      );
      assertEquals(await app.release("vm-1", "c2"), { ok: true });

      // A VM that served one computer never serves another.
      const used = await app.assign("vm-1", { computer: "c1", device: tempDir() });
      assertEquals(used.error?.code, "denied");
    });
  },
});

test({
  name:
    "a cloud computer's work runs in a home on its disk: a CLI installed there is found, on its next wake too",
  // Pool VMs are Linux (POSIX) machines.
  ignore: POSIX_ONLY,
  fn: async () => {
    await app(async (app) => {
      await (await app.pool()).ready;
      const disk = tempDir();
      assertEquals(await app.assign("vm-1", { computer: "c2", device: disk, code: CODE }), {
        ok: true,
      });
      const home = join(realpathSync(disk), "home");
      assert(existsSync(home), "its home is made on the disk");

      // A job and the terminal: HOME, npm's global prefix under it, and their programs first.
      const job = await app.work<Job>("c2", WORK.jobsStart, {
        scope,
        command: 'printf "%s\\n" "$HOME" "$NPM_CONFIG_PREFIX" "$PATH"',
      });
      const ended = await app.work<JobsWaited>("c2", WORK.jobsWait, { scope, id: job.id });
      const [HOME, prefix, PATH] = ended.stdout!.split("\n");
      assertEquals([HOME, prefix], [home, join(home, ".npm-global")]);
      assertEquals(PATH.split(delimiter).slice(0, 3), [
        join(home, ".local", "bin"),
        join(home, ".npm-global", "bin"),
        process.env.PATH!.split(delimiter)[0],
      ]);
      const shell = await app.work<TerminalResult>("c2", WORK.terminal, {
        scope,
        stdin: 'echo "$HOME"',
      });
      assertEquals(shell.stdout, `${home}\n`);

      // Claude Code, where its installer puts it (~/.local/bin): found, in place of any other.
      mkdirSync(join(home, ".local", "bin"), { recursive: true });
      fakeCli(
        join(home, ".local", "bin"),
        "claude",
        "./program-agents-claude.ts",
        join(tempDir(), "claude.log"),
      );
      const claude = async () =>
        (await app.work<EngineStatus[]>("c2", WORK.agentsStatus, { engines: ["claude"] }))[0];
      assertEquals(await claude(), {
        engine: "claude",
        installed: true,
        version: "2.1.999",
        signedIn: false,
      });

      // Released, and woken on another VM: still there.
      await until(
        async () =>
          !!connectionOf(await loadState(join(disk, ".copilotz", "computer.json")), app.url)
            ?.secret,
        "enrolled",
      );
      assertEquals(await app.release("vm-1", "c2"), { ok: true });
      await until(async () => !(await answers(app, "c2")), "it disconnected");
      await (await app.pool({ vm: "vm-2", token: "local:vm-2.t0ken" })).ready;
      assertEquals(await app.assign("vm-2", { computer: "c2", device: disk }), { ok: true });
      assertEquals((await claude()).version, "2.1.999");
    });
  },
});

test({
  name: "an assignment that can't be served fails, and leaves the VM free",
  // Pool VMs are Linux (POSIX) machines.
  ignore: POSIX_ONLY,
  fn: async () => {
    await app(async (app) => {
      await (await app.pool()).ready;
      // Never enrolled, and no code.
      const unenrolled = await app.assign("vm-1", { computer: "c2", device: tempDir() });
      assertEquals(unenrolled.error?.code, "invalid");
      assert(unenrolled.error?.message.includes("code"), unenrolled.error?.message);
      // A code the app doesn't take.
      const refused = await app.assign("vm-1", {
        computer: "c2",
        device: tempDir(),
        code: "WRONG",
      });
      assertEquals(refused.error?.code, "refused");
      // Another computer's disk.
      const disk = tempDir();
      const first = await app.assign("vm-1", { computer: "c2", device: disk, code: CODE });
      assertEquals(first, { ok: true });
      await until(
        async () =>
          !!connectionOf(await loadState(join(disk, ".copilotz", "computer.json")), app.url)
            ?.secret,
        "enrolled",
      );
      assertEquals(await app.release("vm-1", "c2"), { ok: true });
      await (await app.pool({ vm: "vm-2", token: "local:vm-2.t0ken" })).ready;
      const wrong = await app.assign("vm-2", { computer: "c9", device: disk, code: CODE });
      assertEquals(wrong.error?.code, "invalid");
      assert(wrong.error?.message.includes("c2"), wrong.error?.message);
      const relative = await app.assign("vm-2", { computer: "c9", device: "relative/folder" });
      assertEquals(relative.error?.code, "invalid");
    });
  },
});

test({
  name:
    "on Compute Engine, a pool VM's name and identity come from the metadata server, its identity fresh at each registration",
  // Pool VMs are Linux (POSIX) machines.
  ignore: POSIX_ONLY,
  fn: async () => {
    const asked: { path: string; flavor: string | null }[] = [];
    const metadata = await serve((request) => {
      const url = new URL(request.url);
      asked.push({
        path: url.pathname + url.search,
        flavor: request.headers.get("metadata-flavor"),
      });
      if (url.pathname.endsWith("/instance/name")) return new Response("vm-gce\n");
      if (url.pathname.endsWith("/instance/service-accounts/default/identity")) {
        return new Response(JWT);
      }
      return new Response("not here", { status: 404 });
    });
    try {
      await app(async (app) => {
        const pool = await app.pool({
          vm: undefined,
          token: undefined,
          metadata: `${metadata.url}/computeMetadata/v1`,
        });
        await pool.ready;
        assertEquals(pool.vm, "vm-gce");
        assertEquals(await app.rt.call("pooltest.presented", {}), [`gce:${JWT}`]);
        const audience = encodeURIComponent(new URL(app.url).origin);
        assertEquals(asked, [
          { path: "/computeMetadata/v1/instance/name", flavor: "Google" },
          {
            path:
              `/computeMetadata/v1/instance/service-accounts/default/identity?audience=${audience}&format=full`,
            flavor: "Google",
          },
        ]);
        // It answers as the VM it is.
        const released = await app.release("vm-gce", "c2");
        assertEquals(released, { ok: true });
      });
    } finally {
      await metadata.close();
    }
  },
});

test("a pool VM's identity is for the app's origin, also when it's given the app's socket", () => {
  assertEquals(audienceOf("https://app.example.com"), "https://app.example.com");
  assertEquals(audienceOf("https://app.example.com/o/acme"), "https://app.example.com");
  assertEquals(audienceOf("wss://app.example.com/__pool/oxian"), "https://app.example.com");
  assertEquals(audienceOf("ws://127.0.0.1:8080/__pool/oxian"), "http://127.0.0.1:8080");
});

// Signals as macOS and Linux have them.
test({
  name: "`computer pool` runs from the command line; a signal releases what it serves, and ends it",
  ignore: process.platform === "win32",
  fn: () =>
    app(async (app) => {
      const main = fileURLToPath(new URL("../computers/program/main.ts", import.meta.url));
      const home = tempDir();
      const child = spawn(
        process.execPath,
        [
          ...(runtime === "deno" ? ["run", "-A"] : runtime === "bun" ? ["run"] : []),
          main,
          "pool",
          "--app",
          app.url,
          "--vm",
          "vm-cli",
          "--root",
          join(home, "mnt"),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            COPILOTZ_COMPUTER_STATE: join(home, "computer.json"),
            COPILOTZ_POOL_TOKEN: "local:vm-cli.t0ken",
          },
          stdio: "ignore",
        },
      );
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      try {
        await until(
          () => app.release("vm-cli", "c2").then((answer) => !answer.error, () => false),
          "it connected",
          20_000,
        );
        const disk = tempDir();
        assertEquals(await app.assign("vm-cli", { computer: "c2", device: disk, code: CODE }), {
          ok: true,
        });
        const job = await app.work<Job>("c2", WORK.jobsStart, { scope, command: "sleep 30" });
        child.kill("SIGTERM");
        const code = await exited;
        // Deno's child_process says the signal it sent, even when the child then exits as it chose.
        if (runtime !== "deno") assertEquals(code, 0);
        assert(!(await answers(app, "c2")), "its computer stopped with it");
        // Released, not killed: its jobs stopped too, rather than running on, orphaned.
        await until(() => !alive(job.pid!), "its job stopped");
      } finally {
        child.kill("SIGKILL");
      }
    }),
});

test({
  name: "a pool token the app doesn't take ends it",
  // Pool VMs are Linux (POSIX) machines.
  ignore: POSIX_ONLY,
  fn: async () => {
    await app(async (app) => {
      const pool = await app.pool({ token: "local:vm-1.wrong" });
      const error = await assertRejects(() => pool.closed);
      assertEquals((error as { code?: string }).code, "refused");
      await assertRejects(() => pool.ready);
    });
  },
});

// The disk as a device (`/dev/…`) is mounted, which needs Linux and root, and a spare block device
// to format (`COPILOTZ_TEST_DEVICE`: a loop device, say): a folder stands in for it elsewhere.
const DEVICE = env("COPILOTZ_TEST_DEVICE");

test({
  name:
    "a disk is formatted its first wake, mounted as the computer's root, and unmounted on release",
  ignore: process.platform !== "linux" || !DEVICE,
  fn: () =>
    app(async (app) => {
      const mount = join(tempDir(), "mnt");
      const mounted = () => readFileSync("/proc/mounts", "utf8").includes(` ${mount} `);
      await (await app.pool({ root: mount })).ready;
      const first = await app.assign("vm-1", {
        computer: "c2",
        device: DEVICE!,
        code: CODE,
        format: true,
      });
      assertEquals(first, { ok: true });
      assert(mounted(), "it's mounted");
      const statePath = join(mount, ".copilotz", "computer.json");
      await until(
        async () => !!connectionOf(await loadState(statePath), app.url)?.secret,
        "enrolled",
      );
      await app.work<Job>("c2", WORK.jobsStart, { scope, command: "sleep 30", keep: true });
      assertEquals(await app.release("vm-1", "c2"), { ok: true });
      assert(!mounted(), "it's unmounted");

      // Its next wake: what it kept is on the disk (not formatted again).
      assertEquals(await app.assign("vm-1", { computer: "c2", device: DEVICE! }), { ok: true });
      assert(mounted(), "it's mounted again");
      const jobs = await app.work<Job[]>("c2", WORK.jobsList, { scope, all: true });
      assertEquals(jobs.map((job) => [job.command, job.running]), [["sleep 30", true]]);
      assertEquals(await app.release("vm-1", "c2"), { ok: true });
      assert(!mounted(), "it's unmounted again");
    }),
});

test({
  name: "a device that doesn't appear fails the assignment",
  ignore: process.platform !== "linux",
  fn: () =>
    app(async (app) => {
      await (await app.pool({ deviceMs: 300 })).ready;
      const missing = await app.assign("vm-1", {
        computer: "c2",
        device: "/dev/disk/by-id/google-not-there",
        code: CODE,
      });
      assertEquals(missing.error?.code, "not_found");
    }),
});

test({
  name:
    "a free pool VM takes the app's newer release, updates itself and ends to start again; serving a computer, it doesn't",
  ignore: POSIX_ONLY,
  fn: async () => {
    const next = "#!/bin/sh\necho 99.0.0\n";
    const sha256 = createHash("sha256").update(next).digest("hex");
    const program = join(tempDir(), "computer");
    writeFileSync(program, `#!/bin/sh\necho ${VERSION}\n`, { mode: 0o755 });
    const files = await serve((request) =>
      new URL(request.url).pathname === "/release/computer"
        ? new Response(next)
        : new Response("Not found", { status: 404 })
    );
    // The app's release, as `downloads` says it, and what its pool's `ready` does as a VM comes.
    const release = definePlugin({
      name: "release-test",
      resources: {
        downloads: {
          base: `${files.url}/release/`,
          manifest: {
            version: "99.0.0",
            binaries: [{
              os: process.platform,
              arch: process.arch,
              file: "computer",
              size: next.length,
              sha256,
            }],
          },
        },
      },
      actions: {
        "pooltest.offer": defineAction({
          input: { type: "object", properties: { vm: { type: "string" } } },
          run: (ctx, input) => offerUpdate(ctx, POOL_KIND, input.vm!),
        }),
      },
    });
    try {
      await app(async (app) => {
        // Serving a computer, it isn't updated: that VM goes once it's released.
        const busy = await app.pool({ vm: "vm-2", token: "local:vm-2.t0ken", program });
        await busy.ready;
        assertEquals(await app.assign("vm-2", { computer: "c2", device: tempDir(), code: CODE }), {
          ok: true,
        });
        assertEquals(await app.rt.call("pooltest.offer", { vm: "vm-2" }), false);
        assertEquals(readFileSync(program, "utf8"), `#!/bin/sh\necho ${VERSION}\n`);

        // Free, it says what it is, takes the release and ends, for its service to start it again.
        const free = await app.pool({ program });
        await free.ready;
        const info = await app.rt.call<{ version: string; serves: string[] }>("pooltest.work", {
          vm: "vm-1",
          workload: POOL.info,
          input: {},
        });
        assertEquals(info.version, VERSION);
        assert(info.serves.includes(POOL.update), "it takes updates");
        assertEquals(await app.rt.call("pooltest.offer", { vm: "vm-1" }), true);
        assertEquals(await free.closed, "updated");
        assertEquals(readFileSync(program, "utf8"), next);
      }, [release]);
    } finally {
      await files.close();
    }
  },
});

test({
  name: "a pool VM run from source doesn't take updates, and isn't offered one",
  ignore: POSIX_ONLY,
  fn: async () => {
    const release = definePlugin({
      name: "release-test",
      resources: {
        downloads: {
          base: "https://downloads.test/",
          manifest: {
            version: "99.0.0",
            binaries: [{
              os: process.platform,
              arch: process.arch,
              file: "computer",
              size: 1,
              sha256: "a".repeat(64),
            }],
          },
        },
      },
      actions: {
        "pooltest.offer": defineAction({
          input: { type: "object", properties: { vm: { type: "string" } } },
          run: (ctx, input) => offerUpdate(ctx, POOL_KIND, input.vm!),
        }),
      },
    });
    await app(async (app) => {
      const pool = await app.pool({ program: null });
      await pool.ready;
      const started = Date.now();
      assertEquals(await app.rt.call("pooltest.offer", { vm: "vm-1" }), false);
      assert(Date.now() - started < 5_000, "not waited for");
    }, [release]);
  },
});
