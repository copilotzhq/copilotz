/**
 * Where an agent's work goes: a computer in the conversation's space (its
 * desk there: the one the agent names, else the space's default, else one
 * online), its folder, and who answers what it asks (the person it works
 * for, unless the computer's owner keeps that to themselves). Agents use a
 * space's computers only in its conversations, and none when it has none.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Thread } from "../../../agents/chat/contract.ts";
import type { Desk } from "../collections/desk.ts";
import { personOf } from "./person.ts";
import type { Scope } from "./workloads.ts";

/** Where work goes: the desk, whom it's for, who answers, its scope, and how many the space has. */
export type Where = {
  desk: Desk;
  person: string;
  answerer: string;
  scope: Scope;
  computers?: number;
};

/** The desks a space's agents may use, the one they use first. */
export async function desksIn(ctx: Context, space: string): Promise<Desk[]> {
  const desks = await ctx.as().db.collection<Desk>("desk").find({ in: space }, {
    sort: { seen: -1 },
  });
  return desks.sort((a, b) => Number(!!b.default) - Number(!!a.default));
}

/** How a computer is now, as an agent reads it: a cloud computer that isn't on wakes when used. */
export function stateOf(desk: Desk): "online" | "asleep" | "waking" | "offline" {
  if (desk.online) return "online";
  if (desk.status?.kind !== "cloud") return "offline";
  return desk.status.state === "waking" ? "waking" : "asleep";
}

/** A person, as an agent reads them (their id, until people's names are resolved here). */
export const nameOf = (person: string): string => person;

/** One computer, for a list to choose from: `Laptop (online)`, `Cloud (asleep: wakes when used)`. */
const choiceOf = (desk: Desk) => {
  const state = stateOf(desk);
  return `${desk.name ?? desk.computer} (${
    state === "asleep" ? "asleep: using it wakes it" : state
  })`;
};

/** The space's computers to choose from. */
export const choices = (desks: Desk[]): string => desks.map(choiceOf).join(", ");

/**
 * A computer an agent names, among a space's: its desk's id, its computer's
 * id, or its name (any case; else the one whose name has it, when only one
 * does). Unknown or ambiguous, what the agent is told, with the names to
 * choose from.
 */
export function named(desks: Desk[], name: string): { desk: Desk } | { missing: string } {
  const exact = desks.find((d) => d._id === name || d.computer === name);
  if (exact) return { desk: exact };
  const key = name.trim().toLowerCase();
  const called = (d: Desk) => (d.name ?? "").trim().toLowerCase();
  const same = desks.filter((d) => called(d) === key);
  const like = same.length ? same : desks.filter((d) => key && called(d).includes(key));
  if (like.length === 1) return { desk: like[0] };
  if (like.length > 1) {
    return {
      missing: `More than one of this space's computers is called "${name}": ${
        like.map((d) => `${choiceOf(d)}, whose id is ${d._id}`).join("; ")
      }. Give the id of the one you mean.`,
    };
  }
  return {
    missing: desks.length
      ? `There's no computer called "${name}" in this space. Its computers: ${choices(desks)}.`
      : "There's no computer in this space.",
  };
}

/**
 * Where an agent works in a thread: on the computer it names (`computer`),
 * else the space's default, else one online; or why it can't (no person, no
 * computer here, that one offline).
 */
export async function whereFor(
  ctx: Context,
  thread: string,
  who: string,
  computer?: string,
): Promise<Where | { missing: string }> {
  const person = personOf(ctx.actor);
  if (!person) return { missing: "There's no person this work is for, so no computer to use." };
  // Read as the agent (for its person): a conversation they don't reach has no computer for them.
  const found = await ctx.db.collection<Thread>("thread").findOne({ _id: thread });
  if (!found) {
    return { missing: "There's no computer for this conversation: it isn't one of yours." };
  }
  const space = found.in;
  if (!space) {
    return { missing: "This conversation isn't in a space, so there's no computer here." };
  }
  const desks = await desksIn(ctx, space);
  if (computer) {
    const found = named(desks, computer);
    if ("missing" in found) return found;
    const chosen = found.desk;
    if (!chosen.online) {
      const others = desks.filter((d) => d !== chosen && stateOf(d) !== "offline");
      return {
        missing: `${chosen.name ?? "That computer"} is ${
          stateOf(chosen) === "offline"
            ? `offline: ${nameOf(chosen.owner)} can start it again`
            : "still waking: try again in a moment"
        }.${others.length ? ` Use another: ${choices(others)}.` : ""}`,
      };
    }
    return { ...placed(chosen, person, space, who), computers: desks.length };
  }
  const desk = desks.find((d) => d.online);
  if (!desk) {
    return {
      missing: desks.length
        ? `This space's computer, ${desks[0].name ?? "theirs"}, is offline: ${
          desks[0].owner
        } can start it again (on it: deno task computer).`
        : `There's no computer in this space: ${person} can connect one, or add one of ` +
          "theirs, from the space (in the terminal: /computer connect or /computer share).",
    };
  }
  return { ...placed(desk, person, space, who), computers: desks.length };
}

/** Work on this desk: its folder in the space, and who answers. */
const placed = (desk: Desk, person: string, space: string, who: string): Where => ({
  desk,
  person,
  answerer: desk.answers === "owner" ? desk.owner : person,
  scope: { space, folder: desk.folder, who },
});
