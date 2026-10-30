/**
 * `account.connect`: starts connecting one of the person's accounts. It
 * answers the address to sign in at and, for a provider that sends people
 * to an address the app can't serve, where they'll land (`paste`), to paste
 * back with `account.complete`; any other sends them back to the app's
 * callback (`origin`: the page's, unless the app sets `accounts.url`).
 * Unrecorded: its answer carries the sign-in's state, which stays out of
 * the log.
 */
import { defineAction } from "../../../../runtime/mod.ts";
import { start } from "../shared/flow.ts";

export const connectAction = defineAction({
  description: "Starts connecting one of your accounts: where to sign in",
  record: false,
  input: {
    type: "object",
    properties: { provider: { type: "string" }, origin: { type: "string" } },
    required: ["provider"],
    additionalProperties: false,
  },
  allow: (actor) => actor.kind === "person",
  run: (ctx, input) => start(ctx, input.provider, input.origin),
});
