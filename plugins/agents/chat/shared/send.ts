/** `send_message`: checking a call, building what it writes, and the tool as agents see it. */
import type { Actor, Context } from "../../../../runtime/mod.ts";
import type { LlmTool } from "../../../models/contract.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { agentsNamed, now, rosterOf, SEND, type Team } from "./agents.ts";
import { starts } from "./delivery.ts";
import { type Agent, settingsOf, type Turn } from "./types.ts";

export type Send = {
  output: string;
  message?: Message & { hops: number };
  thread?: Thread;
  /** It goes to another space: trusted code writes it, once its person may. */
  across?: true;
};

/** Whom work is for: the person found along `for` and `via`, carrying any limit or origin of theirs. */
export function principalOf(actor: Actor | undefined): Actor | undefined {
  for (let a = actor, hops = 0; a && hops < 4; hops++) {
    if (a.kind === "person") return a;
    a = (a.for ?? a.via) as Actor | undefined;
  }
  return undefined;
}

/**
 * Hands work to an agent of another space, in a new chat there that its members
 * see, for the same person, who must be able to write there. The agent need
 * not work there itself: its person sends it. The answer comes back to the chat
 * it was sent from (`back`).
 */
async function handOver(
  ctx: Context,
  t: Turn,
  step: string,
  id: string,
  input: Record<string, unknown>,
  space: string,
  where?: string,
): Promise<Send> {
  const fail = (why: string) => ({ output: `Not sent: ${why}` });
  const principal = principalOf(ctx.actor);
  if (!principal) return fail("you aren't working for anyone who could send this there.");
  const as = ctx.as(principal);
  const can = await as.call<{ can: boolean }>("space.can", { space, verb: "write" })
    .then((r) => r.can, () => false);
  if (!can) return fail(`the person you work for can't write in the space "${space}".`);
  const roster = await rosterOf(as, space);
  const others = roster.here.filter((name) => name !== t.agent);
  const to = String(input.to ?? "") || roster.default.find((name) => name !== t.agent) || others[0];
  if (!to) return fail("no other agent answers in that space.");
  if (!others.includes(to)) {
    return fail(`nobody called "${to}" answers there. You can message: ${others.join(", ")}.`);
  }
  if (!starts(ctx, t.hops + 1)) {
    return fail(
      `this conversation reached its limit of ${settingsOf(ctx).maxHops} agent messages in a row.`,
    );
  }
  const text = String(input.text ?? "");
  if (!text) return fail("the message is empty.");
  const at = now();
  const fresh = `${id}:thread`;
  const chat = `/thread/${encodeURIComponent(fresh)}?in=${encodeURIComponent(space)}`;
  const from = `/thread/${encodeURIComponent(t.thread)}${
    where ? `?in=${encodeURIComponent(where)}` : ""
  }`;
  const named = (await agentsNamed(ctx, [t.agent]))[t.agent]?.name || t.agent;
  return {
    output: `Sent to ${to} in a new chat in that space (${chat})${
      input.expectReply === false ? "." : "; you'll have the reply before you continue."
    }`,
    across: true,
    message: {
      _id: id,
      thread: fresh,
      in: space,
      from: t.agent,
      to: [to],
      text,
      hops: t.hops + 1,
      via: { kind: "delegated", name: named, path: from },
      back: { thread: t.thread, ...(where ? { in: where } : {}) },
      ...(input.expectReply === false ? { expectReply: false } : {}),
      at,
    },
    thread: {
      _id: fresh,
      title: text.slice(0, 80),
      parent: { thread: t.thread, message: step },
      agents: [to],
      in: space,
      at,
    },
  };
}

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
  const space = typeof input.space === "string" ? input.space : undefined;
  if (space && space !== where) return await handOver(ctx, t, step, id, input, space, where);
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
      "space: to hand work to another space's agents, the id of one your context lists: a new " +
      "chat opens there, which its members see, and to is optional (who answers there). Say " +
      "everything they need: they don't see this conversation, and whoever is there can read it.",
      ...(agents.length ? ["Agents:", ...agents] : []),
      ...(people.length ? [`People: ${people.join(", ")}`] : []),
    ].join("\n"),
    input: {
      type: "object",
      properties: {
        to: { type: "string", description: "One agent or person, by name." },
        text: { type: "string" },
        in: { type: "string", enum: ["thread", "subthread", "new_thread"] },
        space: { type: "string", description: "Another space's id, to hand work to its agents." },
        expectReply: { type: "boolean", description: "False for a message that needs no answer." },
      },
      required: ["text"],
    },
  };
}
