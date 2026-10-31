import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsShown } from "../shared/agents.ts";
import { nameOf, namesIn } from "../../../access/spaces/contract.ts";

/** People by name. */
const named = (ids: string[], ctx: ViewContext) => {
  const names = namesIn(ctx, ids);
  return ids.map((id) => nameOf(id, names));
};

/** Who is in the conversation, and how its messages read. */
export function participants(
  { thread, history }: { thread: Thread; history: Message[] },
  ctx: ViewContext,
): string {
  const me = ctx.viewer?.name ?? "";
  const present = new Set([...(thread.agents ?? []), ...history.flatMap((m) => [m.from, ...m.to])]);
  const agents = agentsShown(ctx, [me, ...present]) ?? {};
  const others = [...present].filter((name) => agents[name] && name !== me);
  const people = [...present].filter((name) => !agents[name]);
  const called = (name: string) =>
    agents[name]?.name ? `${agents[name].name}, called ${name}` : name;
  return [
    `You are ${called(me)}, in a conversation.`,
    others.length
      ? `Other agents here: ${
        others.map((name) =>
          agents[name].description ? `${called(name)} (${agents[name].description})` : called(name)
        )
          .join("; ")
      }.`
      : "",
    people.length ? `People here: ${named(people, ctx).join(", ")}.` : "",
    `Others' messages read "name: text"; "name → x: text" was addressed to x, not to you. ` +
    `Your answer goes back to whoever addressed you.`,
  ].filter(Boolean).join("\n");
}
