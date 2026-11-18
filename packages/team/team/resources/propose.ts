/**
 * `propose_agent`: an agent proposes a new agent, for the person it works for
 * to approve. It drafts the agent (a name, an emoji, what it does, its
 * instructions, its kind of work) and where it would work: this space, or the
 * whole org's team. The person is asked as chat asks for everything (its
 * `ask`: a card in the conversation, Allow or No), and the turn waits. Only
 * what the person could do themselves goes: a space they manage, the org's
 * team if they run the org. Allowed, it's made (`agent.create`, as the app,
 * on the person's yes) and works there at once; the agent can hand it the
 * work. Never made without that yes.
 */
import { type Context, personOf } from "copilotz";
import { ask, tool, type ToolContext } from "copilotz/plugins/agents/contract";
import { ORG } from "copilotz/plugins/access/contract";

/** Whether the person runs the org, or manages the space: what they could do themselves. */
async function mayMake(ctx: Context, person: string, where: string): Promise<boolean> {
  const system = ctx.as();
  if (where === ORG) {
    const role = (await system.db.collection<{ role?: string }>("member")
      .findOne({ _id: `${ORG}|person:${person}` }))?.role;
    return role === "owner" || role === "admin";
  }
  const seat = await system.db.collection<{ role?: string }>("member")
    .findOne({ _id: `${where}|person:${person}` });
  return seat?.role === "manager";
}

export const proposeAgent = tool({
  title: "Propose an agent",
  description: "Propose a new agent for a job that keeps coming back, for the person you work " +
    "for to approve (they see it and answer Allow or No; the turn waits). Give it a short name, " +
    'an emoji, what it does in a sentence or two, its instructions in the second person ("You ' +
    'are…"), the kind of work it does (one your context lists), and where it works: this ' +
    "space, or the whole org's team. Use it when the person asks for one, or when a specialist " +
    "would clearly do a recurring job better; never for a one-off.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 60 },
      icon: { type: "string", maxLength: 16 },
      description: { type: "string", minLength: 1, maxLength: 500 },
      instructions: { type: "string", minLength: 1, maxLength: 20_000 },
      kind: { type: "string", maxLength: 40 },
      where: { type: "string", enum: ["space", "org"] },
    },
    required: ["name", "description", "instructions"],
    additionalProperties: false,
  },
  run: async (input, ctx: ToolContext) => {
    const person = personOf(ctx.actor);
    if (!person) return "Only a person can approve a new agent: there's no one to ask here.";
    const where = input.where === "org" ? ORG : ctx.in;
    if (!where) return "There's no space here to add it to: say where it should work.";
    if (!await mayMake(ctx, person, where)) {
      return where === ORG
        ? "Only the org's owners and admins add agents to its team: suggest it to them."
        : "Only this space's managers add agents here: suggest it to one of them.";
    }
    const place = where === ORG ? "the org's team (every space)" : "this space";
    const verdict = await ask(ctx, {
      owner: person,
      for: person,
      agent: ctx.agent,
      thread: ctx.thread,
      ...(ctx.in ? { in: ctx.in } : {}),
      work: "agent",
      on: `agent:${input.name.toLowerCase()}`,
      detail: `${input.icon ? `${input.icon} ` : ""}${input.name}: ${input.description}`,
      text: `add ${input.name} to ${place}`,
      covers: `add agents to ${place}`,
      answers: ["once", "deny"],
      doing: `add a new agent, ${input.name}, to ${place}`,
      question: `May I add a new agent, ${input.name}, to ${place}?\n${input.description}`,
    });
    if (verdict !== true) return verdict;
    // Their yes: made as the app, as they could have made it.
    const system = ctx.as();
    const { agent } = await system.call<{ agent: string }>("agent.create", {
      in: where,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.kind ? { like: input.kind } : {}),
    });
    if (where !== ORG) {
      await system.call("member.set", {
        space: where,
        member: { kind: "agent", id: agent },
        role: "editor",
      });
    }
    return `Made @${agent}: it works in ${place} now. Hand it the work with send_message.`;
  },
});
