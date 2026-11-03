import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Thread } from "../collections/thread.ts";
import type { ContextEntry } from "../shared/types.ts";

/** One context: its `context:<name>` View, tagged as data unless it's the app's instructions. */
export function contextView(
  { thread, key, entry }: { thread: Thread; key: string; entry: ContextEntry },
  ctx: ViewContext,
): string | undefined {
  const text = ctx.show(`context:${key}`, thread);
  if (!text) return undefined;
  return trusted(entry) ? String(text) : `<context name="${key}">\n${text}\n</context>`;
}

/** Whether a context is the app's own instructions, sent as they are. */
export const trusted = (entry: ContextEntry) =>
  entry.instructions === true && entry.place === "system";
