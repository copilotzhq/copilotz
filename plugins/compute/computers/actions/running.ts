/**
 * `computer.running` `{ computer }`: the jobs running on a computer now, in
 * every space it's in, whoever's (only the system calls this: the cloud
 * plugin, before it lets a cloud computer's VM go). Answers `{ jobs }`;
 * fails with code `offline` when it isn't connected.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { failed } from "../shared/failed.ts";
import { type Job, type JobsListInput, WORK } from "../shared/workloads.ts";

export const runningAction = defineAction({
  input: {
    type: "object",
    properties: { computer: { type: "string" } },
    required: ["computer"],
    additionalProperties: false,
  },
  // No `allow`: only the system.
  run: async (ctx, input) => {
    const desks = await ctx.as().db.collection<Desk>("desk").find({ computer: input.computer });
    const jobs: Job[] = [];
    for (const desk of desks) {
      const answer = await ctx.workers.call<Job[]>(
        "computer",
        input.computer,
        WORK.jobsList,
        {
          scope: { space: desk.in, folder: desk.folder, who: "system" },
          all: true,
        } satisfies JobsListInput,
      );
      const error = failed(answer);
      if (error) throw error;
      jobs.push(...answer.filter((job) => job.running));
    }
    return { jobs };
  },
});
