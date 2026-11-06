/**
 * `account.callback`: a provider sent the person back after they signed in
 * (`/accounts/callback/<provider>`, this plugin's route), with the code and
 * state it gave: the sign-in must be theirs. It answers how it went
 * (`{ connected }`, or `{ failed, why }`: a code, never what the provider
 * said), which the route sends them to Connected accounts with. Unrecorded:
 * the code stays out of the log.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { codeOf } from "../shared/errors.ts";
import { finish } from "../shared/flow.ts";

export const callbackAction = defineAction({
  description: "Finishes connecting an account, once its provider sent the person back",
  record: false,
  input: {
    type: "object",
    properties: {
      provider: { type: "string", maxLength: 100 },
      code: { type: "string", maxLength: 4096 },
      state: { type: "string", maxLength: 4096 },
      /** What the provider said went wrong instead, if it did. */
      error: { type: "string", maxLength: 200 },
    },
    required: ["provider"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: async (ctx, input): Promise<{ connected: string } | { failed: string; why: string }> => {
    const { provider, code, state, error } = input;
    try {
      await finish(ctx, provider, { code, state, error });
      return { connected: provider };
    } catch (failure) {
      return { failed: provider, why: codeOf(failure) ?? "failed" };
    }
  },
});
