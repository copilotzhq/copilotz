/**
 * The computer's background jobs: started, listed, read and stopped by whose
 * they are; another agent neither sees nor stops them (its person's panel
 * lists them all).
 */
import { assert, assertEquals } from "@std/assert";
import process from "node:process";
import { test } from "../../../testing/mod.ts";
import {
  type Job,
  type JobsLogs,
  type JobsWaited,
  type Scope,
  WORK,
} from "../computers/shared/workloads.ts";
import { setup, until } from "./program-setup.ts";

const scope = (who: string, folder = "alpha"): Scope => ({ space: `space-${folder}`, folder, who });
type Failed = { error: { code: string; message: string } };

// bash's redirections and signals (143: ended by SIGTERM); PowerShell's jobs are program-powershell.test.ts's.
test({
  name: "a job runs on, its output kept, until it's stopped",
  ignore: process.platform === "win32",
  fn: () => jobRunsOn(),
});

async function jobRunsOn() {
  await setup(async ({ work }) => {
    const job = await work<Job>(WORK.jobsStart, {
      scope: scope("agent:a"),
      command: "echo hello; echo oops >&2; pwd; sleep 30",
      name: "server",
    });
    assertEquals([job.who, job.name, job.running, job.exitCode], ["agent:a", "server", true, null]);
    assert(job.pid && job.id.startsWith("job-"));
    const logs = () => work<JobsLogs>(WORK.jobsLogs, { scope: scope("agent:a"), id: job.id });
    await until(async () => (await logs()).stdout.includes("alpha"), "it wrote");
    const kept = await logs();
    assertEquals(kept.stdout.split("\n")[0], "hello");
    assert(kept.stdout.trim().endsWith("/alpha"), "it ran in the space's folder");
    assertEquals([kept.stderr, kept.truncated, kept.job.running], ["oops\n", false, true]);
    const tail = await work<JobsLogs>(WORK.jobsLogs, {
      scope: scope("agent:a"),
      id: job.id,
      tail: 3,
    });
    assertEquals([tail.stderr, tail.truncated], ["ps\n", true]);

    const stopped = await work<Job>(WORK.jobsStop, { scope: scope("agent:a"), id: job.id });
    assertEquals([stopped.running, stopped.exitCode], [false, 143]);
    assert(stopped.endedAt);
    // A job that ends on its own says how.
    const quick = await work<Job>(WORK.jobsStart, { scope: scope("agent:a"), command: "exit 7" });
    await until(
      async () =>
        (await work<JobsLogs>(WORK.jobsLogs, { scope: scope("agent:a"), id: quick.id })).job
          .running === false,
      "it ended",
    );
    const ended = await work<JobsLogs>(WORK.jobsLogs, { scope: scope("agent:a"), id: quick.id });
    assertEquals(ended.job.exitCode, 7);
  });
}

test("another agent neither sees nor stops a job; its person's panel lists them all", async () => {
  await setup(async ({ work }) => {
    const mine = await work<Job>(WORK.jobsStart, { scope: scope("agent:a"), command: "sleep 30" });
    const theirs = await work<Job>(WORK.jobsStart, {
      scope: scope("agent:b"),
      command: "sleep 30",
    });
    const elsewhere = await work<Job>(WORK.jobsStart, {
      scope: scope("agent:a", "beta"),
      command: "sleep 30",
    });
    const ids = (jobs: Job[]) => jobs.map((job) => job.id).sort();
    assertEquals(ids(await work(WORK.jobsList, { scope: scope("agent:a") })), [mine.id]);
    assertEquals(ids(await work(WORK.jobsList, { scope: scope("agent:b") })), [theirs.id]);
    // All of the space's, whoever's: not another space's.
    const all = await work<Job[]>(WORK.jobsList, { scope: scope("person:p1"), all: true });
    assertEquals(ids(all), [mine.id, theirs.id].sort());
    assertEquals(all.find((job) => job.id === theirs.id)?.who, "agent:b");
    assertEquals(ids(await work(WORK.jobsList, { scope: scope("agent:a", "beta") })), [
      elsewhere.id,
    ]);

    const refused = await work<Failed>(WORK.jobsStop, { scope: scope("agent:b"), id: mine.id });
    assertEquals(refused.error.code, "not_found");
    const unread = await work<Failed>(WORK.jobsLogs, { scope: scope("agent:b"), id: mine.id });
    assertEquals(unread.error.code, "not_found");
    // From another space, not even its own who.
    const across = await work<Failed>(WORK.jobsStop, {
      scope: scope("agent:a", "beta"),
      id: mine.id,
    });
    assertEquals(across.error.code, "not_found");
    assertEquals(
      (await work<Job>(WORK.jobsStop, { scope: scope("agent:a"), id: mine.id })).running,
      false,
    );
  });
});

// bash's signals (143: ended by SIGTERM); the wait itself is the same on Windows.
test({
  name: "a wait on a job answers once it ends, with the end of its output, or after a while",
  ignore: process.platform === "win32",
  fn: () =>
    setup(async ({ work }) => {
      // Still running past the wait: it says so.
      const nap = await work<Job>(WORK.jobsStart, { scope: scope("agent:a"), command: "sleep 30" });
      const still = await work<JobsWaited>(WORK.jobsWait, {
        scope: scope("agent:a"),
        id: nap.id,
        ms: 50,
      });
      assertEquals([still.job.running, still.stdout, still.stderr], [true, undefined, undefined]);
      // Ended on its own while waited on: it answers then, with how, and what it wrote last.
      const build = await work<Job>(WORK.jobsStart, {
        scope: scope("agent:a"),
        command: "sleep 0.3; echo compiled; echo warned >&2; exit 3",
      });
      const started = Date.now();
      const ended = await work<JobsWaited>(WORK.jobsWait, {
        scope: scope("agent:a"),
        id: build.id,
        tail: 6,
      });
      assert(Date.now() - started < 10_000, "it answered when the job ended");
      assertEquals(
        [ended.job.running, ended.job.exitCode, ended.job.stopped, ended.stdout, ended.stderr],
        // Its last 6 characters of each.
        [false, 3, undefined, "piled\n", "arned\n"],
      );
      // Stopped meanwhile: it says it was stopped, not that it ended on its own.
      const waiting = work<JobsWaited>(WORK.jobsWait, { scope: scope("agent:a"), id: nap.id });
      await work<Job>(WORK.jobsStop, { scope: scope("agent:a"), id: nap.id });
      const stopped = await waiting;
      assertEquals([stopped.job.running, stopped.job.stopped], [false, true]);
      // Another's job isn't there to wait on.
      const refused = await work<Failed>(WORK.jobsWait, { scope: scope("agent:b"), id: nap.id });
      assertEquals(refused.error.code, "not_found");
    }),
});
