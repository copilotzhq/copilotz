/**
 * The push plugin's rules (the runtime's `guard`): a person reads their own
 * devices, nobody reaches anyone else's, agents included, and subscriptions
 * change only through the plugin's Actions.
 */
import { failure, type Guard } from "../../../../runtime/mod.ts";

const NOBODY = { _id: { $in: [] } };

export const rules: Guard = (actor, { collection, access, direct }) => {
  if (collection === "pushLooking") return NOBODY;
  if (collection !== "pushSubscription") return undefined;
  if (direct && access === "write") {
    throw failure("forbidden", "Notifications are turned on and off through their Actions.", {
      public: true,
    });
  }
  return actor.kind === "person" ? { person: actor.id } : NOBODY;
};
