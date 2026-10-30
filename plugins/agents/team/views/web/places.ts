/**
 * Spaces as chat's web front end reads them (the spaces plugin's
 * `space.reached`, by name): what each is called (yours is "Personal"),
 * whether the person manages one, and those they manage and still use,
 * Personal first: where they make agents and add them.
 */

/** A space, as `space.reached` answers: with what the person may do there. */
export type Place = {
  _id: string;
  name: string;
  kind: string;
  can?: string[];
  /** The agent that answers its new chats. */
  agent?: string;
  archived?: string;
};

/** What a space is called where it shows: yours is "Personal". */
export const placeName = (place: Pick<Place, "name" | "kind">) =>
  place.kind === "personal" ? "Personal" : place.name;

/** Whether the person manages it. */
export const manages = (place?: Pick<Place, "can"> | null) => !!place?.can?.includes("manage");

/** The spaces the person manages, in use: Personal first, then by name. */
export const managed = <P extends Place>(places: P[]): P[] =>
  places.filter((p) => manages(p) && !p.archived).sort((a, b) =>
    Number(b.kind === "personal") - Number(a.kind === "personal") ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

/** A space's page, at a tab. */
export const placePath = (place: string, tab?: string) =>
  `/space/${encodeURIComponent(place)}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
