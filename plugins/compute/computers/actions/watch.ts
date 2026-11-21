/**
 * `computer.watch` `{ id }`: waits for a watched job to end (`jobWatch`),
 * then tells its agent in the chat it was started in, and the watch goes.
 * Run by its timer: started with the job, and again each time its computer
 * comes (`computer.ready`), so a wait a computer going offline (or a deploy)
 * cut short is taken up again.
 *
 * The computer answers once the job ends, or after a while with it still
 * running (`jobs.wait`): then it's asked again at once. A computer whose
 * program is older, without that wait, is asked how the job is each minute
 * (`jobs.logs`). One that isn't connected isn't asked: it's watched again
 * when it comes. A job the computer no longer has (it stopped with the
 * computer, which started again) is told as that.
 *
 * Its agent is told as the person it worked for, in their name (as a
 * routine's message is theirs: `via` the job), so its turn is theirs, with
 * their plan and their reach: how it ended (its exit code, or that someone
 * stopped it), how long it ran, and the end of what it wrote. The watch is
 * taken before that (deleted), so it's told once, however many waits end. A
 * job its agent stops itself (`stop_job`) isn't watched by then.
 */
import { type Context, defineAction } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import { type JobWatch, watchTimer } from "../collections/job-watch.ts";
import { failed } from "../shared/failed.ts";
import { type JobsLogs, type JobsWaited, WAIT_MS, WORK } from "../shared/workloads.ts";

/** How often a computer without `jobs.wait` is asked how a job is. */
const POLL_MS = 60_000;

/** How a call fails when its computer's connection goes, or the app's, while it waits. */
const LOST = new Set(["handler_failed", "connection_lost", "cancelled", "unavailable"]);

/** What of a job's output its agent is told: the end of each stream. */
const TAIL = 2_000;

const log = (what: string) => (error: unknown) =>
  console.error(`computers: ${what}:`, error instanceof Error ? error.message : error);

export const watchAction = defineAction({
  input: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  // No `allow`: its timers call it, as the system.
  run: async (ctx, input) => {
    const system = ctx.as();
    const watches = system.db.collection<JobWatch>("jobWatch");
    const watch = await watches.findOne({ _id: input.id });
    if (!watch) return { watching: false };
    const computer = await system.db.collection<Computer>("computer")
      .findOne({ _id: watch.computer });
    if (!computer) {
      await watches.deleteOne({ _id: watch._id });
      return { watching: false };
    }
    // Not connected: watched again when it comes.
    if (!computer.online) return { watching: true };
    const waits = (computer.info as { serves?: string[] } | undefined)?.serves
      ?.includes(WORK.jobsWait);
    const again = (ms: number) =>
      ctx.schedule("computer.watch", { id: watch._id }, {
        at: Date.now() + ms,
        id: watchTimer(watch._id),
      });
    let answer: unknown;
    try {
      answer = waits
        ? await ctx.workers.call("computer", watch.computer, WORK.jobsWait, {
          scope: watch.scope,
          id: watch.job,
          ms: WAIT_MS,
          tail: TAIL,
        })
        : await ctx.workers.call("computer", watch.computer, WORK.jobsLogs, {
          scope: watch.scope,
          id: watch.job,
          tail: TAIL,
        });
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Not connected: watched again when it comes. Its connection lost meanwhile (it went, or
      // the app's restarting): asked again in a minute, unless it comes back first. Anything else
      // is said, and asked again in a minute too.
      if (code === "offline") return { watching: true };
      if (!LOST.has(code ?? "")) log(`waiting on ${watch.name} (${watch._id})`)(error);
      await again(POLL_MS);
      return { watching: true };
    }
    const error = failed(answer);
    if (error && error.code !== "not_found") {
      // It couldn't be asked as it was (its scope): it'd fail the same way again.
      log(`waiting on ${watch.name} (${watch._id})`)(error);
      await watches.deleteOne({ _id: watch._id });
      return { watching: false };
    }
    const waited = error ? undefined : answer as JobsWaited | JobsLogs;
    if (waited?.job.running) {
      await again(waits ? 0 : POLL_MS);
      return { watching: true };
    }
    // Taken: whichever wait gets here first tells it, once; a job its agent stopped is gone.
    const { deletedCount } = await watches.deleteOne({ _id: watch._id });
    if (!deletedCount) return { watching: false };
    await tell(ctx, watch, waited).catch(log(`telling ${watch.agent} that ${watch.name} ended`));
    return { watching: false, told: true };
  },
});

/** Its agent, told in its chat, as the person it worked for. */
async function tell(ctx: Context, watch: JobWatch, waited?: JobsWaited | JobsLogs) {
  const person = ctx.as({
    kind: "person",
    id: watch.person,
    in: watch.in,
    ...(watch.origin ? { origin: watch.origin } : {}),
  });
  await person.call("chat.send", {
    thread: watch.thread,
    text: noticeOf(watch, waited),
    to: [watch.agent],
    via: { kind: "job", name: watch.name.slice(0, 120) },
  });
}

/** What its agent is told: how it ended, how long it ran, and the end of what it wrote. */
export function noticeOf(watch: Pick<JobWatch, "name" | "job">, waited?: JobsWaited): string {
  const named = `Job "${watch.name}" (${watch.job})`;
  if (!waited) {
    return `${named} is no longer on the computer: it stopped with the computer, which went ` +
      "offline or started again, so how it ended isn't known.";
  }
  const { job, stdout, stderr } = waited;
  const ran = job.endedAt ? ` after ${took(job.startedAt, job.endedAt)}` : "";
  const how = job.stopped
    ? `${named} was stopped${ran}.`
    : `${named} ended${ran}, with exit code ${job.exitCode}.`;
  const shown = [
    stdout?.trim() ? `Its output ended with:\n${fenced(stdout)}` : "",
    stderr?.trim() ? `Its errors ended with:\n${fenced(stderr)}` : "",
  ].filter(Boolean);
  return [how, ...shown, shown.length ? "job_logs has the rest." : "It wrote nothing."]
    .join("\n\n");
}

/** Text in a fence that its own backticks can't close. */
const fenced = (text: string) => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text.replace(/\n+$/, "")}\n${fence}`;
};

/** How long from `from` to `to`, as people say it: 45 s, 12 min, 2 h 5 min. */
export function took(from: string, to: string): string {
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}
