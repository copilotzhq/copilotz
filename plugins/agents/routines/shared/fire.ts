/**
 * One run of a routine: as its maker, it sends its message to its agent
 * (`chat.send`), in a new chat named after it, or in the same one as
 * before, and records how it went, on the routine and as a run of its own.
 * A maker who can no longer write where it posts (they left the space) makes
 * the run fail as `forbidden`; a refused send (the agent no longer answers
 * there) fails it with chat's words. Either is recorded, not retried: it
 * would fail the same way again. Records are the system's, so a run its
 * maker can't see still says why.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Thread } from "../../chat/contract.ts";
import type { Routine } from "../collections/routine.ts";
import type { RoutineRun } from "../collections/run.ts";
import { asMaker, timing } from "./routines.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";

export type Ran = Pick<RoutineRun, "outcome" | "thread" | "error"> & { run: string };

export async function fire(
  ctx: Context,
  routine: Routine,
  run: { id: string; due?: string; by?: string },
): Promise<Ran> {
  const system = ctx.as();
  const runs = system.db.collection<RoutineRun>("routineRun");
  // A run that already went (a retry of it) answers as it went.
  const done = ctx.retry ? await runs.findOne({ _id: run.id }) : null;
  if (done) return { run: run.id, outcome: done.outcome, thread: done.thread, error: done.error };

  const maker = asMaker(ctx, routine.by);
  const at = new Date().toISOString();
  let outcome: RoutineRun["outcome"] = "sent";
  let thread: string | undefined;
  let message: string | undefined;
  let error: string | undefined;
  const { can } = await maker.call<{ can: boolean }>("space.can", {
    space: routine.in,
    verb: "write",
  });
  if (!can) {
    outcome = "forbidden";
    const maker = nameOf(routine.by, await namesFor(system, [routine.by]));
    error = `${maker} can't write in this space anymore, and the routine sends as them.`;
  } else {
    // The same chat, while it's still there and still in this space.
    const same = routine.post === "same" && routine.thread
      ? await system.db.collection<Thread>("thread").findOne({ _id: routine.thread })
      : null;
    const into = same?.in === routine.in ? same._id : undefined;
    try {
      const sent = await maker.call<{ thread: string; message: string }>("chat.send", {
        ...(into ? { thread: into } : { in: routine.in }),
        text: routine.text,
        to: [routine.agent],
      });
      thread = sent.thread;
      message = sent.message;
      // A new chat is named after the routine.
      if (!into) {
        await maker.db.collection("thread").updateOne({ _id: thread }, {
          $set: { title: routine.name },
        });
      }
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      if (!code) throw failure;
      outcome = code === "forbidden" ? "forbidden" : "failed";
      error = (failure as Error).message;
    }
  }
  const last = {
    at,
    outcome,
    ...(thread ? { thread } : {}),
    ...(error ? { error } : {}),
  };
  const next = timing(routine.schedule, Date.now(), routine.since).next;
  await system.transaction(async (tx) => {
    await tx.db.collection("routineRun").insertOne({
      _id: run.id,
      routine: routine._id,
      in: routine.in,
      at,
      ...(run.due ? { due: run.due } : {}),
      outcome,
      ...(thread ? { thread } : {}),
      ...(message ? { message } : {}),
      ...(error ? { error } : {}),
      ...(run.by ? { by: run.by } : {}),
    });
    await tx.db.collection("routine").updateOne({ _id: routine._id }, {
      $set: {
        last,
        ...(next && !routine.paused ? { next } : {}),
        ...(routine.post === "same" && thread ? { thread } : {}),
      },
      ...(!next || routine.paused ? { $unset: { next: "" } } : {}),
      $inc: { runs: 1 },
    });
  });
  return { run: run.id, outcome, ...(thread ? { thread } : {}), ...(error ? { error } : {}) };
}
