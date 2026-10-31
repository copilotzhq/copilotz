/** The memory contexts' Views: how to remember, what each agent has in mind, and what comes up each turn. */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Message, Thread } from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import { GUIDE, scopeOf } from "../shared/scope.ts";
import { applies } from "../shared/settings.ts";

/** When a conversation began: its first shared message's time (none yet: undefined; null while read). */
function began(thread: Thread, ctx: ViewContext): string | undefined | null {
  if (!thread.opened) return undefined;
  const first = ctx.db.collection<Message>("message").findOne({ _id: thread.opened });
  return first.status === "ready" ? first.value?.at : null;
}

export const contextViews = {
  // In the system text: how to use memory. The same everywhere, so cached.
  "context:memory": {
    llm: (_thread: Thread, ctx: ViewContext) =>
      applies(ctx, ctx.viewer?.name ?? "") ? GUIDE : undefined,
  },
  // Told when the conversation begins, and kept there: core memories about who's
  // here, as it began knowing them. What's learned since comes up in recall.
  "context:remembered": {
    llm: (thread: Thread, ctx: ViewContext) => {
      const scope = scopeOf(thread, ctx);
      if (!scope || !applies(ctx, scope.agent)) return undefined;
      const start = began(thread, ctx);
      if (start === null) return undefined;
      const core = ctx.db.collection<Memory>("memory").query<Memory[]>("core", {
        agent: scope.agent,
        thread: scope.thread,
        people: scope.people,
        ...(scope.in ? { in: scope.in } : {}),
        ...(start ? { before: start } : {}),
      });
      if (core.status !== "ready" || !core.value.length) return undefined;
      return [
        "What you remember about the people here, yourself and everyone (memories can be " +
        "out of date: what's said in the conversation wins):",
        ...core.value.map((m) => String(ctx.show("memory", m))),
      ].join("\n");
    },
  },
  // After the conversation, each turn: memories relevant to the latest message
  // (core ones too, learned since the conversation began).
  "context:recall": {
    llm: (thread: Thread, ctx: ViewContext) => {
      const scope = scopeOf(thread, ctx);
      if (!scope?.latest?.text || !applies(ctx, scope.agent)) return undefined;
      const start = began(thread, ctx);
      if (start === null) return undefined;
      const relevant = ctx.db.collection<Memory>("memory").query<Memory[]>("relevant", {
        agent: scope.agent,
        thread: scope.thread,
        people: scope.people,
        ...(scope.in ? { in: scope.in } : {}),
        text: scope.latest.text,
        ...(start ? { since: start } : {}),
      });
      if (relevant.status !== "ready" || !relevant.value.length) return undefined;
      return "Memories that may be relevant to the latest message:\n" +
        relevant.value.map((m) => ctx.show("memory", m)).join("\n");
    },
  },
};
