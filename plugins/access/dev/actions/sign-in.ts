/**
 * `dev.sign-in`: someone signs in by the name they type, for trying things
 * out. A plain name (`ana`) is a person by that id; an email is one too,
 * with that email (so invitations to it reach them), named by its first
 * part. An email someone already has (a person who signed in another way,
 * or moved in from another app under an id of its own) signs in as them,
 * and changes nothing about them, as does the id of someone already there.
 * The web host calls it, as the system, only from this machine (`local`);
 * it's never anyone's to call.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Person } from "../../identity/contract.ts";

const EMAIL = /^[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,64}$/;
const NAME = /^[a-z0-9._-]{1,40}$/;

export const signInAction = defineAction({
  description: "Signs in by name, on this machine: the person, and a new session",
  // Unrecorded: its result is the session's secret.
  record: false,
  input: {
    type: "object",
    properties: { name: { type: "string", maxLength: 129 } },
    required: ["name"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const person = input.name.trim().toLowerCase();
    const email = EMAIL.test(person);
    if (!email && !NAME.test(person)) {
      throw Object.assign(new Error("A name (letters, digits, . _ -) or an email"), {
        code: "invalid",
        public: true,
      });
    }
    // Someone already there, by their email or their id: as they are.
    const people = ctx.as().db.collection<Person>("person");
    const known = email
      ? await people.findOne({ email: person }, { sort: { at: 1 } })
      : await people.findOne({ _id: person });
    if (known) {
      const { session } = await ctx.call<{ session: string }>("session.start", {
        person: known._id,
      });
      return { person: known._id, session };
    }
    await ctx.call("person.set", {
      person,
      ...(email ? { email: person } : {}),
      name: email ? person.split("@")[0] : person,
    });
    const { session } = await ctx.call<{ session: string }>("session.start", { person });
    return { person, session };
  },
});
