/**
 * A person's own work on a space's computer (its desk there), from its
 * panel: their own shell and files in the space's folder, and its agents'
 * jobs there (`as`: whose, for the logs or to stop one). Only where they may
 * work: a member who can write in the space.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Desk } from "../collections/desk.ts";
import { failed } from "../shared/failed.ts";
import { mustBeAble } from "../shared/desks.ts";
import { touch, wake } from "../shared/wake.ts";
import { WORK } from "../shared/workloads.ts";

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

export const workAction = defineAction({
  description: "Works on a space's computer, in its folder there",
  input: {
    type: "object",
    properties: {
      desk: { type: "string" },
      work: { enum: Object.keys(PANEL) },
      input: { type: "object" },
      /** Whose jobs: `agent:<name>` (default: yours). */
      as: { type: "string", pattern: "^agent:[\\w.-]+$" },
    },
    required: ["desk", "work"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input) => {
    // The rules reach only the desks of spaces the person is in; working there takes more.
    const desk = await ctx.db.collection<Desk>("desk").findOne({ _id: input.desk });
    if (!desk) throw Object.assign(new Error("No such computer here"), { code: "invalid" });
    await mustBeAble(ctx, desk.in, "write");
    const who = input.as && input.work.startsWith("jobs.") ? input.as : `person:${ctx.actor!.id}`;
    // A computer that sleeps (a cloud computer) is woken first; used, it stays awake a while.
    if (!desk.online) {
      const woke = await wake(ctx, desk.computer);
      if (typeof woke === "string") {
        throw Object.assign(new Error(woke), { code: "unavailable" });
      }
    }
    const touched = touch(ctx, desk.computer);
    const answer = await ctx.workers.call("computer", desk.computer, PANEL[input.work], {
      ...input.input,
      scope: { space: desk.in, folder: desk.folder, who },
    }).finally(() => touched);
    // What it couldn't do fails the call, saying why (a path outside the folder, a file not there).
    const error = failed(answer);
    if (error) throw error;
    return answer;
  },
});
