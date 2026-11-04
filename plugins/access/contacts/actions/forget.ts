/**
 * `contact.forget`: a contact erased (LGPD, GDPR), by those who manage the
 * space its record lives in. Its memberships go, which ends its access to
 * every chat at once (`member.deleted`), and so does its record
 * (`contact.deleted`: the WhatsApp plugin erases its phone). With `chats`,
 * its chats go too, with everything in them (`chat.erase`). Events keep
 * ids, never what it said or its phone.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import { type Member, must } from "../../spaces/contract.ts";
import { CONTACT, type Contact } from "../collections/contact.ts";

export const forgetAction = defineAction({
  description: "Erases a contact: its access, its record, and with `chats`, its chats",
  input: {
    type: "object",
    properties: { contact: { type: "string" }, chats: { type: "boolean" } },
    required: ["contact"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const system = ctx.as();
    const contact = await system.db.collection<Contact>("contact").findOne({ _id: input.contact });
    if (!contact) throw failure("not_found", `No contact "${input.contact}".`);
    await must(ctx, "manage", contact.in, "Only those who manage its space erase a contact.");
    const key = `${CONTACT}${contact._id}`;
    const memberships = await system.db.collection<Member>("member").find({ member: key });
    const chats = memberships.filter((m) => m.on === "thread")
      .map((m) => m.space.slice("thread:".length));
    if (input.chats) {
      for (const thread of chats) await system.call("chat.erase", { thread });
    }
    await system.transaction(async (tx) => {
      await tx.db.collection("member").deleteMany({ member: key });
      await tx.db.collection("contact").deleteOne({ _id: contact._id });
    });
    return { forgotten: contact._id, chats: input.chats ? chats.length : 0 };
  },
});
