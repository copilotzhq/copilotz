/** `send_message`: checking a call, building what it writes, and the tool as agents see it. */
import type { Context } from "../../../../runtime/mod.ts";
import type { LlmTool } from "../../../models/contract.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsNamed, now, SEND, type Team } from "./agents.ts";
import { starts } from "./delivery.ts";
import { type Agent, settingsOf, type Turn } from "./types.ts";

export type Send = {
  output: string;
  message?: Message & { hops: number };
  thread?: Thread;
};

/** Checks a `send_message` call and builds what it writes; nothing is written yet. */
export const prepare = async (
  ctx: Context,
  t: Turn,
  step: string,
  id: string,
  input: Record<string, unknown>,
  /** Who answers where the thread is: only they are messaged as agents (any, when it's open). */
  here: () => Promise<Team>,
  known: () => Promise<Set<string>>,
  /** The space the turn's thread is in: what it writes goes there too. */
  where?: string,
): Promise<Send> => {
  const team = await here();
  const to = String(input.to ?? "");
  const agents = team.open && !team.agents[to]
    ? { ...team.agents, ...await agentsNamed(ctx, [to]) }
    : team.agents;
  const text = String(input.text ?? "");
  const place = (input.in ?? "thread") as "thread" | "subthread" | "new_thread";
  const fail = (why: string) => ({ output: `Not sent: ${why}` });
  if (!text) return fail("the message is empty.");
  if (to === t.agent) return fail("you can't message yourself.");
  const people = agents[to] ? undefined : await known();
  if (people && !people.has(to)) {
    const names = [...Object.keys(agents).filter((n) => n !== t.agent), ...people];
    return fail(`nobody called "${to}" here. You can message: ${names.join(", ")}.`);
  }
  if (agents[to] && !starts(ctx, t.hops + 1)) {
    return fail(
      `this conversation reached its limit of ${settingsOf(ctx).maxHops} agent messages in a row.`,
    );
  }
  const at = now();
  const inSpace = where ? { in: where } : {};
  const base = {
    _id: id,
    ...inSpace,
    from: t.agent,
    to: [to],
    text,
    hops: t.hops + 1,
    ...(input.expectReply === false ? { expectReply: false } : {}),
    at,
  };
  const waits = input.expectReply === false ? "." : "; you'll have the reply before you continue.";
  if (place === "subthread") {
    const sub = `${id}:sub`;
    return {
      output: `Sent to ${to} in a subthread${waits}`,
      message: { ...base, thread: t.thread, subthread: sub },
      // A fork: whoever is messaged there sees this conversation up to the message.
      thread: {
        _id: sub,
        parent: { thread: t.thread, message: id },
        fork: true,
        agents: agents[to] ? [to] : [],
        ...inSpace,
        at,
      },
    };
  }
  if (place === "new_thread") {
    const fresh = `${id}:thread`;
    return {
      output: `Sent to ${to} in a new thread${waits}`,
      message: { ...base, thread: fresh },
      // Starts from the message alone, and records the step that started it.
      thread: {
        _id: fresh,
        title: text.slice(0, 80),
        parent: { thread: t.thread, message: step },
        agents: agents[to] ? [to] : [],
        ...inSpace,
        at,
      },
    };
  }
  return { output: `Sent to ${to}${waits}`, message: { ...base, thread: t.thread } };
};

/** The `send_message` tool as an agent sees it: whom it can reach and how. */
export function sendTool(others: [string, Agent][], people: string[]): LlmTool {
  const agents = others.map(([name, a]) => `- ${name}${a.description ? `: ${a.description}` : ""}`);
  return {
    name: SEND,
    description: [
      "Send a message to another agent or a person.",
      "Unless expectReply is false, your turn pauses once this step's tools run, and resumes " +
      "when every message you sent in it has a reply: send several in one step to work in " +
      "parallel. Replies come back to you wherever they were written.",
      "in: thread (here, for everyone), subthread (a side conversation hanging from your " +
      "message, where the recipient also sees this conversation so far), new_thread (a " +
      "separate conversation that starts from your message alone).",
      ...(agents.length ? ["Agents:", ...agents] : []),
      ...(people.length ? [`People: ${people.join(", ")}`] : []),
    ].join("\n"),
    input: {
      type: "object",
      properties: {
        to: { type: "string", description: "One agent or person, by name." },
        text: { type: "string" },
        in: { type: "string", enum: ["thread", "subthread", "new_thread"] },
        expectReply: { type: "boolean", description: "False for a message that needs no answer." },
      },
      required: ["to", "text"],
    },
  };
}
