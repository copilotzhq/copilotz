/**
 * `account.changed`: an account was connected, lost (it needs signing in
 * again, or its provider ended it) or disconnected. The audit trail of
 * accounts, by whoever did it, with nothing secret in it: the `account`
 * collection itself records no events, since they'd copy its tokens.
 */
import type { EventDef } from "../../../../runtime/mod.ts";

export const changed: EventDef = {
  description: "An account was connected, lost or disconnected",
  schema: {
    type: "object",
    properties: {
      _id: { type: "string" },
      person: { type: "string" },
      provider: { type: "string" },
      status: { enum: ["connected", "needs_reconnect", "revoked", "disconnected"] },
    },
    required: ["_id", "person", "provider", "status"],
    additionalProperties: false,
  },
};
