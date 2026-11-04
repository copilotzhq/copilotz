/**
 * `whatsapp.set`: those who manage a number's space open it to anyone, or
 * close it again (`open`: a customer line, where a stranger who writes is a
 * contact, in a chat of their own, answered by its agent), choose who
 * answers there (`agent`: one that answers in the space; null, who answers
 * new chats there) and how long a chat stays quiet before a customer's next
 * message starts a new one (`gap`, in hours: 12 unless set). Closed again,
 * strangers are told how to link their phone; its chats stay where they are.
 * A Personal space's number isn't opened: it's its person's alone.
 */
import { defineAction, failure, inPerson } from "../../../../runtime/mod.ts";
import { GAP, type WhatsAppNumber } from "../collections/number.ts";
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
