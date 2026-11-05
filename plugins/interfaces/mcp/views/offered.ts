/**
 * Which of a line's tools a contact is offered (`mcp:offered`, medium
 * `mcp`), as a tool decides it for an agent: a tool whose `offer` is a
 * function is asked, with the client as the agent, the conversation's chat,
 * and reads as the contact (who it'd run as); one that says no isn't
 * listed, and isn't run. Any other `offer` (every agent, some agents) is
 * about the app's agents, not a model outside: the line's list decides.
 *
 * Each is asked on its own: an `offer` that throws (one that assumes what
 * the chat holds, asked for a stand-in) isn't offered, and says so once in
 * the log; the others still are.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Thread, Tool } from "../../../agents/chat/contract.ts";

export type Offering = { tools: string[]; thread: Thread; agent: string };

/** Tools whose `offer` threw, said once each in this process. */
const told = new Set<string>();

export const offeredView = (item: Offering, ctx: ViewContext): string[] => {
  const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
  return item.tools.filter((name) => {
    const offer = Object.hasOwn(tools, name) ? tools[name].offer : undefined;
    if (typeof offer !== "function") return true;
    try {
      return offer(item.agent, item.thread, ctx) === true;
    } catch (error) {
      if (!told.has(name)) {
        told.add(name);
        console.error(`mcp: ${name}'s offer threw, so it isn't offered:`, (error as Error).message);
      }
      return false;
    }
  });
};
