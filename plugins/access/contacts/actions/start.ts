/**
 * `contact.start`: someone outside the org came by a line (wrote to a
 * WhatsApp number), and is a contact now. Made by trusted code, which
 * proved who they are (Meta's signed webhook names the phone), with an id
 * from what brought them (`id`), so a retry makes the same one; starting
 * one that exists changes only its name, if that changed. Its record is
 * shared with it on its own (it reads it, and the agent working for it
 * does): a start cut short between the two (an owner restarted) shares it
 * when it's started again.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { CONTACT, type Contact } from "../collections/contact.ts";

export const startAction = defineAction({
  description: "Makes a contact: someone outside the org who came by a line",
  input: {
    type: "object",
    properties: {
      /** Its id, from what brought it (no personal data: it ends up in events). */
      id: { type: "string", pattern: "^c-[\\w-]{6,80}$" },
      /** The line's space, where its record lives. */
      in: { type: "string", minLength: 1 },
      via: { type: "string", minLength: 1, maxLength: 40 },
      name: { type: "string", maxLength: 120 },
    },
    required: ["in", "via"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const contacts = ctx.db.collection<Contact>("contact");
    const id = input.id ?? `c-${crypto.randomUUID()}`;
    const name = input.name?.trim();
    const share = () =>
      ctx.call("member.set", {
        space: id,
        on: "contact",
        member: { kind: "contact", id },
        role: "viewer",
      });
    // Its record, and its share of it (the record's own key, and the contact's).
    const [known, shared] = await Promise.all([
      contacts.findOne({ _id: id }),
      ctx.as().db.collection("member").findOne({ _id: `${CONTACT}${id}|${CONTACT}${id}` }),
    ]);
    if (known) {
      if (name && known.name !== name) await contacts.updateOne({ _id: id }, { $set: { name } });
      if (!shared) await share();
      return { contact: id };
    }
    await contacts.insertOne({
      _id: id,
      in: input.in,
      via: input.via,
      ...(name ? { name } : {}),
      at: new Date().toISOString(),
    });
    await share();
    return { contact: id };
  },
});
