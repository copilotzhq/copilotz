/**
 * Where a thread's messages turn whole (the outline before it), for chat to
 * read only those for the prompt: from its first message while its outline
 * has weighed them all and not yet cut (`""`), from where it cut after that.
 * A thread whose outline came later (or has none yet) gets chat's own window
 * (`undefined`); `null` while the outline is still being read.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Outline } from "../collections/outline.ts";
import type { Outlined } from "../shared/lines.ts";
import { hasLines } from "../shared/summarized.ts";

export const sinceView = (thread: Outlined, ctx: ViewContext): string | null | undefined => {
  const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread._id });
  if (state.status !== "ready") return null;
  const outline = state.value;
  if (hasLines(outline)) return outline.since;
  return state.value?.complete ? "" : undefined;
};
