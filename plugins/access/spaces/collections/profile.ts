/**
 * How people show, to everyone in the org (people and agents alike): their
 * name, and picture (collection `profile`, its `_id` the person's id). Kept
 * from what sign-in verified (the identity plugin's `person`, whose emails
 * stay their own): a person's id is what everything they do records, and
 * this is what's shown in its place, in pages and in agents' prompts. Only
 * the system writes it.
 */
import { defineCollection, type Infer, people } from "../../../../runtime/mod.ts";
import { namesOf, peopleIn } from "../shared/names.ts";

const profileSchema = {
  type: "object",
  properties: {
    /** Their name as they signed in; else their email's name (before the `@`). */
    name: { type: "string" },
    picture: { type: "string" },
    at: { type: "string" },
  },
  required: ["at"],
} as const;

export const profile = defineCollection({
  schema: profileSchema,
  queries: {
    /**
     * Names by id (`{ ids }`, a member key `person:<id>` too): what shows
     * people, wherever (Views, pages, a terminal's commands); a browser reads
     * profiles only through it.
     */
    names: {
      allow: people,
      run: async (profiles, params: { ids?: unknown }) => {
        const given = Array.isArray(params?.ids) ? params.ids : [];
        const ids = peopleIn(given.filter((id): id is string => typeof id === "string"))
          .slice(0, 500);
        if (!ids.length) return {};
        return namesOf(await profiles.find({ _id: { $in: ids } }) as Profile[]);
      },
    },
    /** Pictures by id (`{ ids }`), for faces beside those names: only those who have one. */
    pictures: {
      allow: people,
      run: async (profiles, params: { ids?: unknown }) => {
        const given = Array.isArray(params?.ids) ? params.ids : [];
        const ids = peopleIn(given.filter((id): id is string => typeof id === "string"))
          .slice(0, 500);
        if (!ids.length) return {};
        const found = await profiles.find({ _id: { $in: ids } }) as Profile[];
        return Object.fromEntries(found.flatMap((p) => p.picture ? [[p._id, p.picture]] : []));
      },
    },
  },
});

export type Profile = Infer<typeof profileSchema> & { _id: string };
