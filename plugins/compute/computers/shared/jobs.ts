/**
 * Which of a space's computers runs a job: given by its id or name, it's
 * looked for on those online, the default first (a job's id is its
 * computer's own), so a preview or an app is made from the computer the job
 * runs on, whichever that is.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { failed } from "./failed.ts";
import { type Job, WORK } from "./workloads.ts";

export async function jobOn(
  ctx: Context,
  desks: Desk[],
  space: string,
  job: string,
  who: string,
): Promise<{ desk: Desk; job: Job } | undefined> {
  for (const desk of desks.filter((d) => d.online)) {
    const jobs = await ctx.workers.call<Job[]>("computer", desk.computer, WORK.jobsList, {
      scope: { space, folder: desk.folder, who },
      all: true,
    }).catch(() => undefined);
    if (!Array.isArray(jobs) || failed(jobs)) continue;
    const found = jobs.find((j) => j.id === job) ?? jobs.find((j) => j.name === job);
    if (found) return { desk, job: found };
  }
  return undefined;
}
