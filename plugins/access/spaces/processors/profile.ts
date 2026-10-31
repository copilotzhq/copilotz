/**
 * A person's profile follows what sign-in verified about them (the identity
 * plugin's `person`, as a sign-in or an org's door sets it): their name,
 * their picture. In order, per person.
 */
import type { Event, ProcessorDef } from "../../../../runtime/mod.ts";
import { keepProfile } from "../shared/profile.ts";

export const profileProcessor: ProcessorDef = {
  on: ["person.created", "person.updated"],
  key: (event: Event) => String(event.data._id),
  run: async (ctx, event) => {
    const doc = event.data.doc as { _id: string; name?: string; email?: string; picture?: string };
    if (doc?._id) await keepProfile(ctx, doc);
  },
};
