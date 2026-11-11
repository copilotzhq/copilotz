import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Outline } from "../collections/outline.ts";

/** Whether anything left a thread's tail as a line: a shared message, or an agent's step. */
export const hasLines = <T extends Pick<Outline, "boundary" | "steps">>(
  outline?: T | null,
): outline is T => Boolean(outline?.boundary || Object.keys(outline?.steps ?? {}).length);

/** Whether a thread's history is summarized, and from when its messages are whole. */
export function summarized(thread: string, ctx: ViewContext): { since?: string } | undefined {
  const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread });
  return state.status === "ready" && hasLines(state.value)
    ? { since: state.value.since }
    : undefined;
}
