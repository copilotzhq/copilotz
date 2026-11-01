/**
 * One run of a routine: as its maker, it sends its message to its agent
 * (`chat.send`, marked as the routine's), in its chat, or in a new one named
 * as it says, and records how it went, on the routine and as a run of its own.
 * Its chat gone or moved to another space, it starts a new one and says so.
 * Its message goes with the routine as its `origin`, on the actor, so its
 * agent's work can be let for this routine alone (see chat's shared/origin.ts).
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
import { asMaker, chatTitle, routinePath, timing } from "./routines.ts";
import { may, nameOf, namesFor } from "../../../access/spaces/contract.ts";

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
  let note: string | undefined;
  if (!await may(maker, "write", routine.in)) {
    outcome = "forbidden";
    const maker = nameOf(routine.by, await namesFor(system, [routine.by]));
    error = `${maker} can't write in this space anymore, and the routine sends as them.`;
  } else {
    // The same chat, while it's still there and still in this space.
    const same = routine.post === "same" && routine.thread
      ? await system.db.collection<Thread>("thread").findOne({ _id: routine.thread })
      : null;
    const into = same?.in === routine.in ? same._id : undefined;
    const each = routine.post === "new";
    try {
      const path = routinePath(routine._id);
      const running = ctx.as({
        kind: "person",
        id: routine.by,
        origin: {
          kind: "routine",
          id: routine._id,
          name: routine.name,
          rev: routine.rev ?? 0,
          path,
        },
      });
      const sent = await running.call<{ thread: string; message: string }>("chat.send", {
        // A new chat each run is named for the run, and its agent may name it for what it found.
        ...(into ? { thread: into } : {
          in: routine.in,
          title: each ? chatTitle(routine, run.due ?? at) : routine.name,
          ...(each ? { renamable: true } : {}),
        }),
        text: routine.text,
        to: [routine.agent],
        via: { kind: "routine", name: routine.name.slice(0, 120), path },
      });
      thread = sent.thread;
      message = sent.message;
      if (routine.thread && !each && !into) {
        note = "Its chat was gone or moved to another space, so it started a new one.";
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
      ...(note ? { note } : {}),
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
