/**
 * `contact.forget`: a contact erased (LGPD, GDPR), by those who manage the
 * space its record lives in. Its memberships go, which ends its access to
 * every chat at once (`member.deleted`), and so does its record
 * (`contact.deleted`: the WhatsApp plugin erases its phone, but not a block
 * on it, kept by a hash). With `chats`, its chats go too, with everything
 * chat and its plugins keep of them (`chat.erase`), each only for someone
 * who manages that chat's space.
 *
 * What's not erased here: the event log, which keeps what happened (what
 * WhatsApp delivered, with the phone and what it said; each change, with
 * its document) until retention removes it; and what's elsewhere, such as
 * memories learned in staff's own chats, or chats a hand-over opened in
 * other spaces.
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
      // Each chat's own space decides: it may have moved since the contact came.
      const threads = await system.db.collection<{ _id: string; in?: string }>("thread")
        .find({ _id: { $in: chats } });
      for (const thread of threads) {
        if (thread.in) {
          await must(ctx, "manage", thread.in, "Only those who manage its chats erase them.");
        }
      }
      for (const thread of threads) await system.call("chat.erase", { thread: thread._id });
    }
    await system.transaction(async (tx) => {
      await tx.db.collection("member").deleteMany({ member: key });
      await tx.db.collection("contact").deleteOne({ _id: contact._id });
    });
    return { forgotten: contact._id, chats: input.chats ? chats.length : 0 };
  },
});
