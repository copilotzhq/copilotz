/**
 * `whatsapp.template`: a template message, one the app declares
 * (`whatsappTemplates`), sent in a WhatsApp chat: what reaches a phone past
 * Meta's 24 hours since it last wrote (a reminder, a follow-up), and starts
 * the conversation again. People who may write in the chat send one, and
 * agents working for them (an app's tool, its `callId` as the `id`); so does
 * the app's own code. Its parameters are checked against the template's
 * body before anything is said (`invalid`).
 *
 * It's said in the chat by an agent (`chat.say`: the chat's, unless `from`
 * names another that answers there), as the template's body says it,
 * filled, to the chat's person or contact; what reaches their phone is the
 * template itself, once. The same `id` in a chat sends once: what caused it
 * (a tool call, a booking); without one, each call sends one. What Meta
 * refuses (a template it hasn't approved, a parameter it won't take) is on
 * the record as that delivery's failure (`template_refused`).
 */
import { defineAction, failure, people } from "../../../../runtime/mod.ts";
import type { Thread } from "../../../agents/chat/contract.ts";
import { CONTACT } from "../../../access/contacts/contract.ts";
import { may } from "../../../access/spaces/contract.ts";
import type { WhatsAppThread } from "../collections/thread.ts";
import { connected } from "../shared/number.ts";
import { templateOf } from "../shared/template.ts";

const said = (code: string, message: string) => failure(code, message, { public: true });

export const templateAction = defineAction({
  description: "Sends a WhatsApp template message in a WhatsApp chat",
  input: {
    type: "object",
    properties: {
      /** The WhatsApp chat. */
      thread: { type: "string" },
      /** The app's name for the template (`whatsappTemplates`). */
      template: { type: "string", minLength: 1 },
      /** Its body's parameters: in order, or by name. */
      params: {
        anyOf: [
          { type: "array", items: { type: "string", maxLength: 1024 }, maxItems: 100 },
          { type: "object", additionalProperties: { type: "string", maxLength: 1024 } },
        ],
      },
      /** Meta's own components besides its body: a header's, a button's. */
      components: { type: "array", items: { type: "object" }, maxItems: 20 },
      /** What caused it: the same id sends once in a chat. */
      id: { type: "string", minLength: 1, maxLength: 120 },
      /** The agent it's said as: one that answers in the chat. */
      from: { type: "string", minLength: 1 },
    },
    required: ["thread", "template"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input): Promise<{ message: string }> => {
    const system = ctx.as().db;
    const chat = await system.collection<WhatsAppThread>("whatsapp_thread")
      .findOne({ _id: input.thread });
    // Read as the caller: a chat they don't reach is no chat to them.
    const thread = chat
      ? await ctx.db.collection<Thread>("thread").findOne({ _id: input.thread })
      : null;
    const to = chat?.person ?? (chat?.contact ? `${CONTACT}${chat.contact}` : undefined);
    if (!chat || !thread || !to) throw said("not_found", "No WhatsApp chat here.");
    if (thread.in && !await may(ctx, "write", thread.in)) {
      throw said("forbidden", "You can't write in this chat.");
    }
    const on = await connected(ctx, chat.number);
    if (!on) throw said("not_found", "This chat's WhatsApp number isn't connected anymore.");
    const { wire, text } = templateOf(ctx, input);
    const from = input.from ?? thread.agents?.[0] ?? on.number.agent;
    if (!from) throw said("invalid", "Say which of the chat's agents says it (`from`).");
    const id = `template:${input.id ?? crypto.randomUUID()}`;
    const message = `${input.thread}:say:${id}`;
    // Said already, by the same cause: nothing more goes.
    if (await system.collection("message").findOne({ _id: message })) return { message };
    // What goes in its place, before it's said, so its delivery finds it.
    await system.collection("whatsapp_template").replaceOne({ _id: message }, {
      thread: input.thread,
      template: input.template,
      name: wire.name,
      language: wire.language,
      ...(wire.components ? { components: wire.components } : {}),
      at: new Date().toISOString(),
    }, { upsert: true });
    await ctx.call("chat.say", { id, thread: input.thread, from, text, to: [to] });
    return { message };
  },
});
