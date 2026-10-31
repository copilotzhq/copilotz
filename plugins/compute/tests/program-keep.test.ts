/**
 * Jobs that serve and jobs that are kept: a job keeps the port it says it
 * serves, and says the ports it listens on (where this machine's tools tell);
 * a kept job is listed on the computer's disk and started again when the
 * computer starts, until whose it is stops it (or it ends on its own).
 */
import { assert, assertEquals } from "@std/assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { runtime, test } from "../../../testing/mod.ts";
import { type Job, type JobsLogs, type Scope, WORK } from "../computers/shared/workloads.ts";
import { setup, until } from "./program-setup.ts";

const scope: Scope = { space: "s", folder: "alpha", who: "agent:a" };
const kept = (root: string) =>
  JSON.parse(readFileSync(join(root, ".copilotz", "jobs.json"), "utf8")) as unknown[];

// bash's `sleep` and `exit`; PowerShell's jobs are program-powershell.test.ts's.
test({
  name: "a kept job is listed on the computer's disk and starts again with it, until it's stopped",
  ignore: process.platform === "win32",
  fn: () =>
    setup(async ({ work, computer, start, root }) => {
      const server = await work<Job>(WORK.jobsStart, {
        scope,
        command: "sleep 30",
        name: "server",
        port: 3000,
        keep: true,
      });
      assertEquals([server.port, server.keep], [3000, true]);
      const plain = await work<Job>(WORK.jobsStart, { scope, command: "sleep 30" });
      assertEquals([plain.port, plain.keep], [undefined, undefined]);
      const entry = {
        folder: "alpha",
        who: "agent:a",
        name: "server",
        command: "sleep 30",
        port: 3000,
      };
      assertEquals(kept(root), [entry]);

      // The computer stops (its jobs with it): the list stays; started again, so is its job.
      await computer.stop();
      assertEquals(kept(root), [entry]);
      await (await start()).ready;
      const again = await work<Job[]>(WORK.jobsList, { scope, all: true });
      assertEquals(again.map((job) => [job.name, job.running, job.port, job.keep]), [
        ["server", true, 3000, true],
      ]);
      assertEquals(kept(root), [entry]);

      // Stopped by whose it is, it's kept no more.
      await work<Job>(WORK.jobsStop, { scope, id: again[0].id });
      assertEquals(kept(root), []);
      // One that ends on its own leaves the list too.
      const quick = await work<Job>(WORK.jobsStart, { scope, command: "exit 3", keep: true });
      await until(
        async () =>
          !(await work<JobsLogs>(WORK.jobsLogs, { scope, id: quick.id })).job.running &&
          kept(root).length === 0,
        "it ended, and left the list",
      );
      const bad = await work<{ error: { code: string } }>(WORK.jobsStart, {
        scope,
        command: "sleep 1",
        port: 0,
      });
      assertEquals(bad.error.code, "invalid");
    }),
});

test("a job running a server says the port it listens on, where this machine can tell", async () => {
  await setup(async ({ work }) => {
    // A tiny server on a free port, saying which, run by this runtime.
    await work(WORK.filesWrite, {
      scope,
      path: "server.mjs",
      content: 'import { createServer } from "node:http";\n' +
        "const server = createServer((_, res) => res.end('ok'));\n" +
        "server.listen(0, '127.0.0.1', () => console.log(`port ${server.address().port}`));\n",
    });
    const program = JSON.stringify(process.execPath);
    const command = runtime === "deno"
      ? `${program} run -A server.mjs`
      : runtime === "bun"
      ? `${program} server.mjs`
      : `${program} server.mjs`;
    const job = await work<Job>(WORK.jobsStart, {
      scope,
      command: process.platform === "win32" ? `& ${command}` : command,
      name: "web",
    });
    let port = 0;
    await until(
      async () => {
        const logs = await work<JobsLogs>(WORK.jobsLogs, { scope, id: job.id });
        port = Number(/port (\d+)/.exec(logs.stdout)?.[1] ?? 0);
        return port > 0;
      },
      "it listened",
      20_000,
    );
    let listed: Job | undefined;
    await until(async () => {
      [listed] = await work<Job[]>(WORK.jobsList, { scope });
      return listed?.ports === undefined || listed.ports.includes(port);
    }, "its port was found");
    // No tool here to tell (no ss, lsof or netstat): it says nothing, rather than none.
    if (listed?.ports === undefined) return console.log("  (no tool to find ports: skipped)");
    assertEquals(listed.ports, [port]);
    const logs = await work<JobsLogs>(WORK.jobsLogs, { scope, id: job.id });
    assertEquals(logs.job.ports, [port]);
    // Stopped, it listens on nothing, and says no ports.
    const stopped = await work<Job>(WORK.jobsStop, { scope, id: job.id });
    assert(!stopped.running);
    const [after] = await work<Job[]>(WORK.jobsList, { scope });
    assertEquals(after.ports, undefined);
  });
});

// bash's `echo`, `sleep` and `$NAME`.
test({
  name: "a job runs with the environment it's given; a kept one starts again with it",
  ignore: process.platform === "win32",
  fn: () =>
    setup(async ({ work, computer, start, root }) => {
      const env = { SPACE_URL: "https://api.test", SPACE_KEY: "s3cret" };
      const told = await work<Job>(WORK.jobsStart, {
        scope,
        command: 'echo "$SPACE_URL $SPACE_KEY"; sleep 30',
        name: "server",
        keep: true,
        env,
      });
      const said = async (id: string) =>
        (await work<JobsLogs>(WORK.jobsLogs, { scope, id })).stdout.trim();
      await until(async () => await said(told.id) === "https://api.test s3cret", "it has them");
      // Kept with it, on the computer's disk (readable only by its user).
      assertEquals((kept(root)[0] as { env?: unknown }).env, env);

      // Started again, it has them again.
      await computer.stop();
      await (await start()).ready;
      const [again] = await work<Job[]>(WORK.jobsList, { scope, all: true });
      await until(async () => await said(again.id) === "https://api.test s3cret", "again");
      await work<Job>(WORK.jobsStop, { scope, id: again.id });

      // A name a shell can't take is refused.
      const bad = await work<{ error: { code: string; message: string } }>(WORK.jobsStart, {
        scope,
        command: "true",
        env: { "no good": "1" },
      });
      assertEquals(bad.error.code, "invalid");
    }),
});

test({
  name: "a shell starts with the environment it's given",
  ignore: process.platform === "win32",
  fn: () =>
    setup(async ({ work }) => {
      const shellScope: Scope = { space: "s", folder: "alpha", who: "agent:shell" };
      const ran = await work<{ stdout: string }>(WORK.terminal, {
        scope: shellScope,
        stdin: 'echo "$SPACE_URL"',
        env: { SPACE_URL: "https://api.test" },
      });
      assertEquals(ran.stdout.trim(), "https://api.test");
    }),
});
