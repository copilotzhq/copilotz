/**
 * What moving a conversation shows, in the terminal's words (`/move`, from
 * `thread.moving`): who'll see it there, and what it drew on.
 */
import type { Moving, MovingPlace } from "../../collections/thread.ts";

/** "A", "A and B", "A, B and C". */
const listed = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * What moving a conversation shows, said before it's done: who'll see it
 * there, and what it drew on (spaces by name; a Personal one as whose it is;
 * those the mover doesn't reach, as others). Nothing drawn on, nothing said.
 */
export function movingWords(
  moving: Moving,
  me: string,
  names: Record<string, string> = {},
): string {
  const whose = (place: MovingPlace) =>
    place.owner === me
      ? "your Personal space"
      : `${names[place.owner!] ?? "someone"}'s Personal space`;
  const { to } = moving;
  const who = to.kind !== "personal"
    ? `Everyone in ${to.name} (${moving.people}) will see this whole conversation.`
    : to.owner === me
    ? "Only you will see this conversation, in your Personal space."
    : `${names[to.owner!] ?? "Someone"} will see this whole conversation, in their Personal space.`;
  const drew = [
    ...moving.drew.map((place) =>
      place.kind === "personal" && place.owner ? whose(place) : place.name
    ),
    ...(moving.elsewhere === 1
      ? ["another space"]
      : moving.elsewhere > 1
      ? [`${moving.elsewhere} other spaces`]
      : []),
  ];
  return drew.length ? `${who} It drew on ${listed(drew)}.` : who;
}
