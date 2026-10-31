/**
 * Computers that sleep (cloud computers, which another plugin keeps): when
 * an app has something that wakes them (the `computerWake` resource: an
 * Action that wakes one, `wake`, and one told of every use, `touch`), work
 * for a computer that's offline wakes it first, and waits for it; every
 * piece of work says it was used, so it stays awake a while. The waking
 * Action answers null for a computer it doesn't keep (a person's own), which
 * stays as it is. Without the resource, nothing changes.
 *
 * ```ts
 * resources: { computerWake: { wake: "cloud.wake", touch: "cloud.touch" } }
 * ```
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Thread } from "../../../agents/chat/contract.ts";
import type { Desk } from "../collections/desk.ts";
import { desksIn, named, type Where, whereFor } from "./where.ts";

export type ComputerWake = { wake?: string; touch?: string };

const hookOf = (ctx: Pick<Context, "resources">) =>
  ctx.resources.computerWake as ComputerWake | undefined;

/**
 * Wakes `computer` if something wakes computers and it's one that sleeps:
 * true once it's awake and its desks show it, false when it isn't one that
 * sleeps (or nothing wakes computers), else what whoever asked is told (it's
 * still waking, or why it couldn't).
 */
export async function wake(ctx: Context, computer: string): Promise<boolean | string> {
  const hook = hookOf(ctx);
  if (!hook?.wake) return false;
  try {
    if (!await ctx.call(hook.wake, { computer })) return false;
    // Connected: its desks show it a moment later (`computer.ready` marks them after it).
    const desks = ctx.as().db.collection<Desk>("desk");
    for (let i = 0; i < 100 && await desks.findOne({ computer, online: false }); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (error as { code?: string }).code === "waking"
      ? "The computer is waking: try again in a minute."
      : message.startsWith("The computer")
      ? message
      : `The computer couldn't wake: ${message}`;
  }
}

/**
 * Says `computer` was used, alongside the work (fire and forget: the work
 * doesn't wait on it), or, `view`, that a person has it open (which keeps
 * it awake longer). What fails is logged. Await what it returns to know
 * it's done.
 */
export function touch(ctx: Context, computer: string, view?: boolean): Promise<void> {
  const hook = hookOf(ctx);
  if (!hook?.touch) return Promise.resolve();
  return ctx.call(hook.touch, view ? { computer, view } : { computer }).then(
    () => {},
    (error) =>
      console.error(
        `${hook.touch} ${computer}:`,
        error instanceof Error ? error.message : error,
      ),
  );
}

/**
 * Where an agent works in a thread (see `whereFor`): the computer it names
 * (`computer`), else its space's own (its default, else the one seen last),
 * woken first when it's asleep and something wakes computers.
 */
export async function whereAwake(
  ctx: Context,
  thread: string,
  who: string,
  computer?: string,
): Promise<Where | { missing: string }> {
  if (hookOf(ctx)?.wake) {
    // Read as the agent, as whereFor does: a conversation they don't reach wakes nothing.
    const talk = await ctx.db.collection<Thread>("thread").findOne({ _id: thread });
    const desks = talk?.in ? await desksIn(ctx, talk.in) : [];
    const found = computer ? named(desks, computer) : { desk: desks[0] };
    const chosen = "desk" in found ? found.desk : undefined;
    if (chosen && !chosen.online) {
      const woke = await wake(ctx, chosen.computer);
      if (typeof woke === "string") return { missing: woke };
    }
  }
  return await whereFor(ctx, thread, who, computer);
}
