/**
 * `whatsapp.set`: those who manage a number's space open it to anyone, or
 * close it again (`open`: a customer line, where a stranger who writes is a
 * contact, in a chat of their own, answered by its agent), choose who
 * answers there (`agent`: one that answers in the space; null, who answers
 * new chats there) and how long a chat stays quiet before a customer's next
 * message starts a new one (`gap`, in hours: 12 unless set), how many
 * messages a customer may send a minute (`rate`: 20), how long they may
 * write on before the agent answers them all at once (`quiet`, seconds: 4),
 * and the language
 * customers are told things in (`language`: `en`, `pt`). Closed again,
 * strangers are told how to link their phone; its chats stay where they are.
 * A Personal space's number isn't opened: it's its person's alone.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import { GAP, type WhatsAppNumber } from "../collections/number.ts";
import type { WhatsAppThread } from "../collections/thread.ts";
import { blockedKey } from "../collections/blocked.ts";
import { mustManage } from "./connect.ts";
import { PERSONAL } from "../../../access/spaces/contract.ts";

export const setAction = defineAction({
  description: "Opens a WhatsApp number to anyone (a customer line), or closes it",
  input: {
    type: "object",
    properties: {
      number: { type: "string" },
      open: { type: "boolean" },
      agent: { type: ["string", "null"] },
      /** Hours. */
      gap: { type: "number", minimum: 1, maximum: 720 },
      /** Messages a customer may send a minute. */
      rate: { type: "integer", minimum: 1, maximum: 600 },
      /** Seconds a customer may write on before the agent answers. */
      quiet: { type: "number", minimum: 0, maximum: 30 },
      language: { type: "string", enum: ["en", "pt"] },
    },
    required: ["number"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const numbers = ctx.db.collection<WhatsAppNumber>("whatsapp_number");
    const found = await numbers.findOne({ _id: input.number });
    if (!found) throw failure("not_found", "No such number here.");
    await mustManage(ctx, found.in, "change its number");
    if (found.declared) {
      throw failure("invalid", "This number is the app's own: its settings say how it works.");
    }
    if (input.open) {
      const space = await ctx.db.collection<{ kind?: string }>("space").findOne({ _id: found.in });
      if (space?.kind === PERSONAL) {
        throw failure(
          "invalid",
          "A customer line belongs in a shared space: a Personal one is yours alone.",
        );
      }
    }
    const agent = input.agent as string | null | undefined;
    if (agent) {
      const { agents } = await ctx.call<{ agents: string[] }>("space.roster", { space: found.in });
      if (!agents.includes(agent)) {
        throw failure(
          "invalid",
          `"${agent}" doesn't answer in this space: add it as an editor first.`,
        );
      }
    }
    const set = {
      ...(input.open ? { open: true } : {}),
      ...(agent ? { agent } : {}),
      ...(input.gap !== undefined ? { gap: input.gap } : {}),
      ...(input.rate !== undefined ? { rate: input.rate } : {}),
      ...(input.quiet !== undefined ? { quiet: input.quiet } : {}),
      ...(input.language ? { language: input.language } : {}),
    };
    const unset = {
      ...(input.open === false ? { open: "" } : {}),
      ...(agent === null ? { agent: "" } : {}),
    };
    if (Object.keys(set).length || Object.keys(unset).length) {
      // As the person: the rules say they manage the space.
      await numbers.updateOne({ _id: found._id }, {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      });
    }
    const now = await numbers.findOne({ _id: found._id });
    return { open: !!now?.open, agent: now?.agent ?? null, gap: now?.gap ?? GAP };
  },
});

/**
 * `whatsapp.block`: those who manage a number's space block the phone of
 * one of its chats (a customer who abuses the line), or let it in again:
 * what a blocked phone sends goes nowhere, and nothing is said to it, even
 * once the contact is erased (the block is kept by the phone's hash).
 */
export const blockAction = defineAction({
  description: "Blocks the phone behind a WhatsApp chat, or lets it in again",
  input: {
    type: "object",
    properties: { thread: { type: "string" }, blocked: { type: "boolean" } },
    required: ["thread", "blocked"],
    additionalProperties: false,
  },
  allow: inPerson,
  run: async (ctx, input) => {
    const system = ctx.as().db;
    const chat = await system.collection<WhatsAppThread>("whatsapp_thread")
      .findOne({ _id: input.thread });
    const number = chat
      ? await system.collection<WhatsAppNumber>("whatsapp_number").findOne({ _id: chat.number })
      : null;
    if (!chat || !number) throw failure("not_found", "No WhatsApp chat here.");
    await mustManage(ctx, number.in, "block a phone");
    const _id = await blockedKey(number._id, chat.phone);
    const blocks = system.collection("whatsapp_blocked");
    if (input.blocked) {
      await blocks.replaceOne({ _id }, { number: number._id, at: new Date().toISOString() }, {
        upsert: true,
      });
    } else await blocks.deleteOne({ _id });
    return { blocked: input.blocked };
  },
});
