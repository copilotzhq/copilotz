/** The memory contexts' Views: how to remember, what each agent has in mind, and what comes up each turn. */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Message, Thread } from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import { GUIDE, learnedOf, scopeOf } from "../shared/scope.ts";
import { applies } from "../shared/settings.ts";

/** The most of a message the search for relevant memories reads (characters). */
const READ = 4_000;

/**
 * The memories this agent was told here (its `recall` contexts) that it still
 * has whole (after where history summarizes, when it does): not told again.
 * "" when none; null while they're read.
 */
function toldHere(thread: Thread, agent: string, ctx: ViewContext): string | null {
  const since = ctx.show("history.since", thread);
  if (since === null) return null;
  const mine = ctx.db.collection<Message>("message").find(
    { thread: thread._id, from: agent, ...(since ? { at: { $gte: since } } : {}) },
    { sort: { at: -1 }, limit: 50 },
  );
  if (mine.status !== "ready") return null;
  return mine.value.flatMap((m) => (m.told ?? []) as { name: string; text: string }[])
    .filter((c) => c.name === "recall").map((c) => c.text).join("\n");
}

/** When a conversation began: its first shared message's time (none yet: undefined; null while read). */
function began(thread: Thread, ctx: ViewContext): string | undefined | null {
  if (!thread.opened) return undefined;
  const first = ctx.db.collection<Message>("message").findOne({ _id: thread.opened });
  return first.status === "ready" ? first.value?.at : null;
}

export const contextViews = {
  // In the system text: how to use memory. The same everywhere, so cached.
  "context:memory": (_thread: Thread, ctx: ViewContext) =>
    applies(ctx, ctx.viewer?.name ?? "") ? GUIDE : undefined,
  // Told when the conversation begins, and kept there: core memories about who's
  // here, as it began knowing them. What's learned since comes up in recall.
  "context:remembered": (thread: Thread, ctx: ViewContext) => {
    const scope = scopeOf(thread, ctx);
    if (!scope || !applies(ctx, scope.agent)) return undefined;
    const start = began(thread, ctx);
    if (start === null) return undefined;
    const core = ctx.db.collection<Memory>("memory").query<Memory[]>("core", {
      agent: scope.agent,
      thread: scope.thread,
      people: scope.people,
      ...(scope.in ? { in: scope.in } : {}),
      ...(scope.everywhere ? { everywhere: true } : {}),
      ...(start ? { before: start } : {}),
    });
    if (core.status !== "ready" || !core.value.length) return undefined;
    return [
      "What you remember about the people here, yourself and everyone (memories can be " +
      "out of date: what's said in the conversation wins):",
      ...core.value.map((m) => String(ctx.show("llm.memory", m))),
    ].join("\n");
  },
  // After the conversation, each turn: memories relevant to the latest message,
  // what came just before it, or what the conversation is about (core ones too,
  // learned since it began), with when and where each was learned.
  "context:recall": (thread: Thread, ctx: ViewContext) => {
    const scope = scopeOf(thread, ctx);
    if (!scope?.latest?.text || !applies(ctx, scope.agent)) return undefined;
    const start = began(thread, ctx);
    if (start === null) return undefined;
    const text = [scope.latest, ...scope.before ?? []].map((m) => m.text ?? "")
      .concat(thread.title ?? "").map((t) => t.slice(0, READ));
    const relevant = ctx.db.collection<Memory>("memory").query<Memory[]>("relevant", {
      agent: scope.agent,
      thread: scope.thread,
      people: scope.people,
      ...(scope.in ? { in: scope.in } : {}),
      ...(scope.everywhere ? { everywhere: true } : {}),
      text,
      ...(start ? { since: start } : {}),
    });
    if (relevant.status !== "ready" || !relevant.value.length) return undefined;
    // What it was told here and still has whole isn't told again: only what's new.
    const told = toldHere(thread, scope.agent, ctx);
    if (told === null) return undefined;
    const fresh = relevant.value.filter((m) => !told.includes(String(ctx.show("llm.memory", m))));
    if (!fresh.length) return undefined;
    // The conversations they were learned in, by title, where it can read them.
    const from = [...new Set(fresh.flatMap((m) => m.source?.thread ?? []))]
      .filter((id) => id !== thread._id);
    const found = from.length
      ? ctx.db.collection<Thread>("thread").find({ _id: { $in: from } })
      : undefined;
    if (found && found.status !== "ready") return undefined;
    const titles = Object.fromEntries((found?.value ?? []).map((t) => [t._id, t.title ?? ""]));
    return "Memories that may be relevant to the latest message:\n" +
      fresh.map((m) => `${ctx.show("llm.memory", m)} (${learnedOf(m, titles, thread._id)})`).join(
        "\n",
      );
  },
};
