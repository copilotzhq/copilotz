/**
 * `computer.provision` `{ owner, name, in? }`: a computer made by the app,
 * not connected with a code (a cloud computer, which the cloud plugin makes;
 * only the system calls this). Its record and secret are made as a code's
 * first connection makes them (the secret kept as a hash, and in the clear
 * until the computer's been told it), with its desk in a space its owner may
 * work in (their Personal space unless it says). Answers `{ id }`.
 */
import { type Actor, defineAction } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import { deskIn, may } from "../shared/desks.ts";
import { hash, secret } from "../shared/secret.ts";

export const provisionAction = defineAction({
  input: {
    type: "object",
    properties: {
      owner: { type: "string" },
      name: { type: "string", minLength: 1 },
      in: { type: "string" },
    },
    required: ["owner", "name"],
    additionalProperties: false,
  },
  // No `allow`: only the system (another plugin's Action) makes computers this way.
  run: async (ctx, input) => {
    const owner: Actor = { kind: "person", id: input.owner };
    const space = input.in ??
      (await ctx.as(owner).call<{ space: string }>("space.personal", {})).space;
    if (input.in && !await may(ctx.as(owner), space, "write")) {
      throw Object.assign(new Error(`${input.owner} can't work in this space.`), {
        code: "forbidden",
      });
    }
    const told = secret();
    const made = {
      owner: input.owner,
      name: input.name,
      online: false,
      at: new Date().toISOString(),
    };
    const { insertedId } = await ctx.as().db.collection<Omit<Computer, "_id">>("computer")
      .insertOne({ ...made, secret: await hash(told), pending: told });
    await deskIn(ctx, { _id: insertedId, ...made }, space);
    return { id: insertedId };
  },
});
