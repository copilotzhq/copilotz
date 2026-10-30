/**
 * The computer's background jobs: started, listed, read and stopped by whose
 * they are; another agent neither sees nor stops them (its person's panel
 * lists them all).
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { type Job, type JobsLogs, type Scope, WORK } from "../computers/shared/workloads.ts";
import { setup, until } from "./program-setup.ts";

const scope = (who: string, folder = "alpha"): Scope => ({ space: `space-${folder}`, folder, who });
type Failed = { error: { code: string; message: string } };

test("a job runs on, its output kept, until it's stopped", async () => {
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
});

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
