/** `request.grant` and `request.deny`: a space's managers decide on a request to join it. */
import { type Context, defineAction, forbidden, people } from "../../../../runtime/mod.ts";
import type { Request } from "../collections/request.ts";
import { joinable } from "../shared/personal.ts";
import { must } from "../shared/can.ts";
import { seat } from "../shared/seat.ts";

/** The request, if the caller manages its space. */
async function decide(ctx: Context, id: string): Promise<Request> {
  const system = ctx.as();
  const found = await system.db.collection<Request>("request").findOne({ _id: id });
  if (!found) throw forbidden(`No request "${id}".`);
  await must(ctx, "manage", found.space, `You don't manage "${found.space}".`);
  return found;
}

export const grantAction = defineAction({
  description: "Lets in whoever a request is for, with a role (viewer by default)",
  input: {
    type: "object",
    properties: { id: { type: "string" }, role: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const found = await decide(ctx, input.id);
    joinable(await ctx.as().db.collection("space").findOne({ _id: found.space }), found.member);
    await seat(ctx, found.space, found.member, input.role ?? "viewer");
    await ctx.as().db.collection("request").deleteOne({ _id: found._id });
    return { granted: found.member, space: found.space };
  },
});

export const denyAction = defineAction({
  description: "Turns a request down",
  input: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const found = await decide(ctx, input.id);
    await ctx.as().db.collection("request").deleteOne({ _id: found._id });
    return { denied: found.member, space: found.space };
  },
});
