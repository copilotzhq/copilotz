/**
 * `chat.welcomed` `{}`: the person has been through the app's welcome, or
 * closed it, so home doesn't show it again by itself. Their own, in person;
 * again changes nothing.
 */
import { defineAction, inPerson, personOf } from "../../../../runtime/mod.ts";

export const welcomedAction = defineAction({
  description: "Marks that you've seen the app's welcome",
  input: { type: "object", additionalProperties: false },
  allow: inPerson,
  run: async (ctx) => {
    const person = personOf(ctx.actor)!;
    // Chat's own record of it, written as the app: nobody writes it but this Action.
    const welcomed = ctx.as().db.collection("welcome");
    if (await welcomed.findOne({ _id: person })) return { welcomed: true };
    await welcomed.insertOne({ _id: person, at: new Date().toISOString() });
    return { welcomed: true };
  },
});
