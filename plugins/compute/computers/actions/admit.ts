/**
 * Who a connecting computer is (the `computer` worker kind's admission, run
 * as the system): `code:<code>` connects a new one for the code's person, in
 * the code's space, whose secret it's told once it's here (`computer.ready`), or, while it
 * hasn't been told yet (its program restarted), that same one again;
 * `<id>.<secret>` is one connected before. Anything else: nobody (null).
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { Enrollment } from "../collections/enrollment.ts";
import { deskIn } from "../shared/desks.ts";
import { hash, same, secret } from "../shared/secret.ts";

export const admitAction = defineAction({
  input: {
    type: "object",
    properties: { secret: { type: "string" } },
    required: ["secret"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const computers = ctx.db.collection<Omit<Computer, "_id">>("computer");
    if (input.secret.startsWith("code:")) {
      const key = await hash(input.secret.slice("code:".length).toUpperCase());
      const enrollments = ctx.db.collection<Enrollment>("enrollment");
      const found = await enrollments.findOne({ _id: key });
      if (!found || found.expires < new Date().toISOString()) {
        if (found) await enrollments.deleteOne({ _id: key });
        return null;
      }
      // The one it connected, not told its secret yet: it again.
      if (found.computer) {
        const again = await computers.findOne({ _id: found.computer }) as Computer | null;
        return again?.pending ? { id: found.computer } : null;
      }
      const told = secret();
      const made = { owner: found.owner, online: false, at: new Date().toISOString() };
      const { insertedId } = await computers.insertOne({
        ...made,
        secret: await hash(told),
        pending: told,
      });
      // A code connects one computer: whoever comes second with it gets that one, or nothing.
      const { modifiedCount } = await enrollments.updateOne(
        { _id: key, computer: { $exists: false } },
        { $set: { computer: insertedId } },
      );
      if (!modifiedCount) {
        await computers.deleteOne({ _id: insertedId });
        return null;
      }
      // In the space it was connected to.
      await deskIn(ctx, { _id: insertedId, ...made }, found.in);
      return { id: insertedId };
    }
    const dot = input.secret.indexOf(".");
    if (dot < 1) return null;
    const id = input.secret.slice(0, dot);
    const known = await computers.findOne({ _id: id }) as Computer | null;
    if (!known || !same(known.secret, await hash(input.secret.slice(dot + 1)))) return null;
    return { id };
  },
});
