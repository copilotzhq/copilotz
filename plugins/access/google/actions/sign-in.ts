/**
 * `google.sign-in`: a Google ID token (from Google's sign-in button) in, a
 * session out. The person is found by their Google account, or made the
 * first time. Called by the host for a connection that isn't anyone yet,
 * so as the system; the host sets the session as a cookie.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import type { Person } from "../../identity/contract.ts";
import type { GoogleKeys } from "../adapters/keys.ts";
import { verify } from "../shared/jwt.ts";
import { settingsOf } from "../shared/settings.ts";

export const signInAction = defineAction({
  description: "Signs in with a Google ID token: the person, and a new session",
  input: {
    type: "object",
    properties: { idToken: { type: "string" } },
    required: ["idToken"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const port = Object.values(ctx.adapters.googleKeys ?? {})[0] as GoogleKeys | undefined;
    if (!port) throw new Error("No googleKeys adapter");
    const { clientId } = settingsOf(ctx);
    const claims = await verify(input.idToken, await port.keys(), clientId);
    const people = ctx.db.collection<Person>("person");
    const known = await people.findOne({ "accounts.google": claims.sub });
    const id = known?._id ?? `google:${claims.sub}`;
    await people.updateOne({ _id: id }, {
      $set: {
        "accounts.google": claims.sub,
        ...(claims.email ? { email: claims.email } : {}),
        ...(claims.name ? { name: claims.name } : {}),
        ...(claims.picture ? { picture: claims.picture } : {}),
        at: known?.at ?? new Date().toISOString(),
      },
    }, { upsert: true });
    const { session } = await ctx.call<{ session: string }>("session.start", { person: id });
    return { person: id, session, new: !known };
  },
});
