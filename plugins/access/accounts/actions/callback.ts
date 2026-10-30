/**
 * `account.callback`: where a provider sends the person back after they sign
 * in (the web host's route, `/accounts/callback/<provider>`): their session
 * says who they are, and the sign-in must be theirs. Either way they land
 * on Connected accounts, which says how it went (`?connected=` or
 * `?failed=…&why=`, a code: never what the provider said). Unrecorded: the
 * code stays out of the log.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { codeOf } from "../shared/errors.ts";
import { finish } from "../shared/flow.ts";

export const CALLBACK = "/accounts/callback/";

/** A provider's name in the path, as it was meant (one that can't be read is none). */
const named = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
};

export const callbackAction = defineAction({
  description: "Where a provider sends people back after they sign in",
  record: false,
  // The web host's `HttpRequest`: its path and query are what it reads.
  input: {
    type: "object",
    properties: {
      path: { type: "string" },
      query: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["path", "query"],
  },
  allow: (actor) => actor.kind === "person" || actor.kind === "visitor",
  run: async (ctx, input) => {
    const name = named(input.path.slice(CALLBACK.length).split("/")[0] ?? "");
    const back = (said: Record<string, string>) => ({
      redirect: `/accounts?${new URLSearchParams(said)}`,
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
    if (ctx.actor?.kind !== "person") return back({ failed: name, why: "signed_out" });
    const { code, state, error } = input.query as Record<string, string | undefined>;
    try {
      await finish(ctx, name, { code, state, error });
      return back({ connected: name });
    } catch (failure) {
      return back({ failed: name, why: codeOf(failure) ?? "failed" });
    }
  },
});
