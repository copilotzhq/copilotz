/**
 * Who'll see a chat moved to another space, said before it moves (kind
 * `chat.moving`, item the chat `{ _id }`, hints `{ to }`: the space), from
 * `thread.moving`: "Everyone in Launch (12 people) will see this whole
 * conversation. It drew on Squad 1 and Finance." Moving into your own
 * Personal space, only you will. What it drew on names the spaces you
 * reach (a Personal one as yours, or as its person's) and counts the rest.
 * The move palette's question shows it as its note.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { Moving, MovingPlace } from "../../collections/thread.ts";
import { names } from "./who.ts";
import { say } from "./words.ts";
import { nameOf, namesIn, PERSONAL } from "../../../../access/spaces/contract.ts";

/**
 * What moving there means, as sentences: who'll see it (`me`, the person
 * moving it; `named`, people's names by id, for others' Personal spaces),
 * and what it drew on, when it drew on anything.
 */
export function movingSaid(moving: Moving, me: string, named: Record<string, string>): string {
  const theirs = (place: MovingPlace) => !!place.owner && place.owner !== me;
  const placeOf = (place: MovingPlace) =>
    place.kind !== PERSONAL
      ? place.name
      : theirs(place)
      ? say("theirPersonalSpace", { name: nameOf(place.owner!, named) })
      : say("yourPersonalSpace");
  const { to, people, drew, elsewhere } = moving;
  const who = to.kind === PERSONAL
    ? theirs(to) ? say("movingTheirs", { name: nameOf(to.owner!, named) }) : say("movingYours")
    : people > 0
    ? say("movingEveryone", { space: to.name, count: people })
    : say("movingEveryoneThere", { space: to.name });
  const on = [
    ...drew.map(placeOf),
    ...(elsewhere === 1
      ? [say("anotherSpace")]
      : elsewhere > 1
      ? [say("otherSpaces", { count: elsewhere })]
      : []),
  ];
  return on.length ? `${who} ${say("movingDrew", { spaces: names(on) })}` : who;
}

export const movingView = (t: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const to = typeof ctx.hints.to === "string" ? ctx.hints.to : undefined;
  if (!t._id || !to) return null;
  // Null when the person doesn't reach that space: nothing to say.
  const moving = ctx.db.collection("thread").query<Moving | null>("moving", { thread: t._id, to })
    .value;
  if (!moving) return null;
  const me = ctx.viewer?.name ?? "";
  const owners = [moving.to, ...moving.drew]
    .flatMap((p) => p.kind === PERSONAL && p.owner && p.owner !== me ? [p.owner] : []);
  return (
    <span className="chat-moving">
      {movingSaid(moving, me, owners.length ? namesIn(ctx, owners) : {})}
    </span>
  );
};
