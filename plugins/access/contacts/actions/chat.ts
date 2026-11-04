/**
 * `contact.chat`: a chat for a contact, in the line's space: chat opens it
 * (`chat.open`, answered by `agent`, else by who answers new chats there),
 * and it's shared with the contact on its own (`member.set`, `on` the
 * thread). They reach it, what's said in it and its files, and nothing else
 * in the space; its members reach it as any chat there. With `thread`, that
 * is its id (from what brought them), so a retry opens the same one. Made by
 * trusted code, which knows who the contact is.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Contact } from "../collections/contact.ts";

export const chatAction = defineAction({
  description: "Opens a chat for a contact, shared with them",
  input: {
    type: "object",
    properties: {
      contact: { type: "string", minLength: 1 },
      in: { type: "string", minLength: 1 },
      thread: { type: "string", minLength: 1, maxLength: 200 },
      agent: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1, maxLength: 120 },
    },
    required: ["contact", "in"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const contact = await ctx.db.collection<Contact>("contact").findOne({ _id: input.contact });
    if (!contact) {
      throw Object.assign(new Error(`No contact "${input.contact}".`), { code: "not_found" });
    }
    const title = input.title ?? contact.name;
    const { thread } = await ctx.call<{ thread: string }>("chat.open", {
      in: input.in,
      ...(input.thread ? { thread: input.thread } : {}),
      ...(input.agent ? { agents: [input.agent] } : {}),
      ...(title ? { title: title.slice(0, 120) } : {}),
    });
    await ctx.call("member.set", {
      space: thread,
      on: "thread",
      member: { kind: "contact", id: contact._id },
      role: "editor",
    });
    return { thread };
  },
});
