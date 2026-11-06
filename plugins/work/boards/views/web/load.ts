/**
 * What a board's Views read, as the person: the board, its cards, its
 * space's members, what chat says of the agents among them and on its cards
 * (their names and emojis), the people's names (their profiles', on its
 * cards too: who made and changed them), and the spaces the person reaches (what they
 * may do there, and what each is called). Each read is live: the View runs
 * again when what it read changes.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { namesIn } from "../../../../access/mod.ts";
import type { Board, Card } from "../../contract.ts";
import { type Names, peopleOf, type Someone, type Team } from "./shown.ts";

/** A space as `space.reached` answers: with what the person may do there. */
export type Place = {
  _id: string;
  name: string;
  kind: string;
  owner?: string;
  archived?: string;
  can?: string[];
};

/** What a space is called where it shows: yours is "Personal". */
export const placeName = (p?: Pick<Place, "name" | "kind">) =>
  !p ? "this space" : p.kind === "personal" ? "Personal" : p.name;

export const placesOf = (ctx: ViewContext<ReactNode>) =>
  ctx.db.collection("space").query<Place[]>("reached", {}).value;

export type Loaded = {
  cards?: Card[];
  people?: Someone[];
  team?: Team;
  names?: Names;
};

/** A board's cards, and who's in its space (people, then agents, shown as chat shows them). */
export function boardData(ctx: ViewContext<ReactNode>, board?: Board | null): Loaded {
  if (!board) return {};
  const cards = ctx.db.collection<Card>("card").find({ in: board.in, board: board._id }).value;
  const members = ctx.db.collection<{ member: string }>("member").find({ space: board.in }).value;
  const held = (cards ?? []).flatMap((c) => c.assignee ? [c.assignee] : []);
  const agents = members
    ? [...new Set([...members.map((m) => m.member), ...held])]
      .filter((k) => k.startsWith("agent:")).map((k) => k.slice(6)).sort()
    : undefined;
  const team = agents
    ? ctx.db.collection("thread").query<Team>("agents", { in: board.in, names: agents }).value
    : undefined;
  const names = namesIn(
    ctx,
    [
      ...(members ?? []).map((m) => m.member),
      ...held,
      ...(cards ?? []).flatMap((c) => [c.by, c.updatedBy]),
    ].filter((k): k is string => !!k?.startsWith("person:")),
  );
  return {
    cards,
    ...(members && (team || !agents?.length)
      ? { people: peopleOf(members, team, ctx.viewer?.name, held, names) }
      : {}),
    ...(team ? { team } : {}),
    names,
  };
}
