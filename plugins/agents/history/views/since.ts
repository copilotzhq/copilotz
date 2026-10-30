/**
 * Where a thread's messages turn whole (the outline before it): chat asks, so
 * it reads only those messages for the prompt.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Outlined } from "../shared/lines.ts";
import { summarized } from "../shared/summarized.ts";

export const sinceView = (thread: Outlined, ctx: ViewContext): string | undefined =>
  thread.outlined ? summarized(thread._id, ctx)?.since : undefined;
