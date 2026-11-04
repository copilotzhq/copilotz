/**
 * `mcp.conversation` `{ conversations }`: which of a conversation's ids,
 * one under each of the app's secrets (its own first, then the one before
 * it, `links.previous`), is the one there: the first whose contact or chat
 * is, or was and is over (erased, or its people took the contact out); -1
 * when none is (a new conversation, made under the app's own secret). The
 * MCP route asks it while the app has a secret before its own, so a
 * conversation made before the secret changed goes on as itself. Nobody
 * outside may.
 */
import { defineAction } from "../../../../runtime/mod.ts";

const id = { type: "string", maxLength: 60 } as const;

export const conversationAction = defineAction({
  description: "Which of a conversation's ids under the app's secrets is the one there",
  record: false,
  input: {
    type: "object",
    properties: {
      conversations: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: { contact: id, thread: id },
          required: ["contact", "thread"],
          additionalProperties: false,
        },
      },
    },
    required: ["conversations"],
    additionalProperties: false,
  },
  run: async (ctx, input): Promise<number> => {
    const system = ctx.as().db;
    const contacts = input.conversations.map((c) => c.contact);
    const threads = input.conversations.map((c) => c.thread);
    const found = await Promise.all([
      system.collection("contact").find({ _id: { $in: contacts } }),
      system.collection("thread").find({ _id: { $in: threads } }),
      system.collection("mcp_closed").find({
        _id: {
          $in: [...contacts.map((c) => `contact:${c}`), ...threads.map((t) => `thread:${t}`)],
        },
      }),
    ]);
    const there = new Set(found.flat().map((d) => String(d._id).replace(/^(contact|thread):/, "")));
    return input.conversations.findIndex((c) => there.has(c.contact) || there.has(c.thread));
  },
});
