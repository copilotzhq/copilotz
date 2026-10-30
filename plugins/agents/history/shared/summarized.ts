import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Outline } from "../collections/outline.ts";

/** Whether a thread's history is summarized, and from when its messages are whole. */
export function summarized(thread: string, ctx: ViewContext): { since?: string } | undefined {
  const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread });
  return state.status === "ready" && state.value?.boundary
    ? { since: state.value.since }
    : undefined;
}
