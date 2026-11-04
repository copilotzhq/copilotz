/**
 * Which of a line's tools a contact is offered (`mcp:offered`, renderer
 * `mcp`), as a tool decides it for an agent: a tool whose `offer` is a
 * function is asked, with the client as the agent, the conversation's chat,
 * and reads as the contact (who it'd run as); one that says no isn't
 * listed, and isn't run. Any other `offer` (every agent, some agents) is
 * about the app's agents, not a model outside: the line's list decides.
 * Undefined while what an `offer` reads is loading.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Thread, Tool } from "../../../agents/chat/contract.ts";

export type Offering = { tools: string[]; thread: Thread; agent: string };

export const offeredView = (item: Offering, ctx: ViewContext): string[] => {
  const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
  return item.tools.filter((name) => {
    const offer = Object.hasOwn(tools, name) ? tools[name].offer : undefined;
    return typeof offer !== "function" || offer(item.agent, item.thread, ctx);
  });
};
