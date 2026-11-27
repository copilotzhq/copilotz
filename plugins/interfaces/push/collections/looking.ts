/**
 * Which of a person's tabs show the app right now (`<person>:<tab>`): each
 * says so when it shows or hides, and again every half minute while it
 * shows. Kept in memory only: it's live, and a restart forgets it, as a
 * closed tab is forgotten after a minute and a half. Nobody reads it but the
 * plugin, which sends nothing to someone looking.
 */
import { defineCollection } from "../../../../runtime/mod.ts";

const lookingSchema = {
  type: "object",
  properties: {
    person: { type: "string" },
    visible: { type: "boolean" },
    at: { type: "string" },
  },
  required: ["person", "visible", "at"],
} as const;

export const pushLooking = defineCollection({ durable: false, schema: lookingSchema });

export type LookingDoc = { _id: string; person: string; visible: boolean; at: string };

/** How long a tab that said it shows counts as showing, unless it says again. */
export const LOOKING_FOR = 90_000;
