import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import type { ContextEntry } from "../shared/types.ts";

/** One context: its `context:<name>` View, tagged as data. */
export function contextView(
  { thread, key }: { thread: Thread; key: string; entry: ContextEntry },
  ctx: ViewContext,
): string | undefined {
  const text = ctx.show(`context:${key}`, thread);
  return text ? `<context name="${key}">\n${text}\n</context>` : undefined;
}
