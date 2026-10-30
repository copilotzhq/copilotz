/** The memory contexts' Views: what each agent has in mind, and what comes up each turn. */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Thread } from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import { GUIDE, scopeOf } from "../shared/scope.ts";
import { applies } from "../shared/settings.ts";

export const contextViews = {
  // In the system text: core memories about who's here. Stable, so cached.
  "context:memory": {
    llm: (thread: Thread, ctx: ViewContext) => {
      const scope = scopeOf(thread, ctx);
      if (!scope || !applies(ctx, scope.agent)) return undefined;
      const core = ctx.db.collection<Memory>("memory").query<Memory[]>("core", {
        agent: scope.agent,
        thread: scope.thread,
        people: scope.people,
        ...(scope.in ? { in: scope.in } : {}),
      });
      if (core.status !== "ready") return undefined;
      return [
        GUIDE,
        ...(core.value.length
          ? [
            "What you remember about the people here, yourself and everyone (memories can be " +
            "out of date: what's said in the conversation wins):",
            ...core.value.map((m) => String(ctx.show("memory", m))),
          ]
          : []),
      ].join("\n");
    },
  },
  // After the conversation, each turn: memories relevant to the latest message.
  "context:recall": {
    llm: (thread: Thread, ctx: ViewContext) => {
      const scope = scopeOf(thread, ctx);
      if (!scope?.latest?.text || !applies(ctx, scope.agent)) return undefined;
      const relevant = ctx.db.collection<Memory>("memory").query<Memory[]>("relevant", {
        agent: scope.agent,
        thread: scope.thread,
        people: scope.people,
        ...(scope.in ? { in: scope.in } : {}),
        text: scope.latest.text,
      });
      if (relevant.status !== "ready" || !relevant.value.length) return undefined;
      return "Memories that may be relevant to the latest message:\n" +
        relevant.value.map((m) => ctx.show("memory", m)).join("\n");
    },
  },
};
