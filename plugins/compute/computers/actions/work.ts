/**
 * A person's own work on a space's computer (its desk there), from its
 * panel: their own shell and files in the space's folder, and its agents'
 * jobs there (`as`: whose, for the logs or to stop one). Only where they may
 * work: a member who can write in the space.
 *
 * A computer that sleeps (a cloud computer) is woken by what does something
 * (a command, a job, a write) or by `wake` (its page opened), and kept awake
 * a while by it; what only reads (a panel polling its jobs) neither wakes it
 * nor keeps it awake, so a page left open lets it sleep.
 */
import { defineAction, forbidden, people } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { failed } from "../shared/failed.ts";
import { jobEnv } from "../shared/env.ts";
import { touch, wake } from "../shared/wake.ts";
import { WORK } from "../shared/workloads.ts";
import { must } from "../../../access/spaces/contract.ts";

/** What a person may do on their computer from its panel. */
const PANEL: Record<string, string> = {
  terminal: WORK.terminal,
  "jobs.start": WORK.jobsStart,
  "jobs.list": WORK.jobsList,
  "jobs.logs": WORK.jobsLogs,
  "jobs.stop": WORK.jobsStop,
  "files.list": WORK.filesList,
  "files.read": WORK.filesRead,
  "files.write": WORK.filesWrite,
  "files.edit": WORK.filesEdit,
  search: WORK.search,
};

/** What only reads: it doesn't say the computer was used. */
const READS = new Set(["jobs.list", "jobs.logs", "files.list", "files.read", "search"]);

export const workAction = defineAction({
  description: "Works on a space's computer, in its folder there",
  input: {
    type: "object",
    properties: {
      desk: { type: "string" },
      work: { enum: [...Object.keys(PANEL), "wake"] },
      input: { type: "object" },
      /** Whose jobs: `agent:<name>` (default: yours). */
      as: { type: "string", pattern: "^agent:[\\w.-]+$" },
    },
    required: ["desk", "work"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    // The rules reach only the desks of spaces the person is in; working there takes more.
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!desk) throw Object.assign(new Error("No such computer here"), { code: "invalid" });
    await must(ctx, "write", desk.in, "You can't work in this space.");
    // Where its owner answers for it, nobody else changes anything on it without them.
    if (desk.answers === "owner" && desk.owner !== ctx.actor!.id && !READS.has(input.work)) {
      throw forbidden("Its owner keeps this computer's answers: only they work on it directly.");
    }
    const who = input.as && input.work.startsWith("jobs.") ? input.as : `person:${ctx.actor!.id}`;
    // A computer that sleeps (a cloud computer) is woken first; used, it stays awake a while.
    if (!desk.online && !READS.has(input.work)) {
      const woke = await wake(ctx, desk.computer);
      if (typeof woke === "string") {
        throw Object.assign(new Error(woke), { code: "unavailable" });
      }
      if (!woke && input.work === "wake") {
        throw Object.assign(new Error("The computer is offline: its owner starts it again."), {
          code: "offline",
        });
      }
    }
    // What changes something keeps it awake a while; reading (a panel polling its jobs) doesn't:
    // a person with it open keeps it awake with computer.view, up to the app's limit.
    const touched = READS.has(input.work) ? Promise.resolve() : touch(ctx, desk.computer);
    if (input.work === "wake") return await touched.then(() => ({ awake: true }));
    // Jobs and shells run with the space's environment (its computers'), and what's given over it.
    const env = input.work === "jobs.start" || input.work === "terminal"
      ? await jobEnv(ctx, desk.in, (input.input as { env?: unknown } | undefined)?.env)
      : undefined;
    const answer = await ctx.workers.call("computer", desk.computer, PANEL[input.work], {
      ...input.input,
      ...(env ? { env } : {}),
      scope: { space: desk.in, folder: desk.folder, who },
    }).finally(() => touched);
    // What it couldn't do fails the call, saying why (a path outside the folder, a file not there).
    const error = failed(answer);
    if (error) throw error;
    return answer;
  },
});
