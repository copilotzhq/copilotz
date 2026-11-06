/**
 * The accounts plugin's rules (the runtime's `guard`): a person reads and
 * changes their own accounts, and nobody else reaches anyone's, agents
 * included (an agent's model gets its person's token through
 * `account.token`, which knows whose to give). Sign-ins under way are the
 * plugin's alone. The system, as ever, is unrestricted. An account is
 * connected (and its tokens renewed) through the plugin's Actions, never
 * written directly from outside.
 */
import { failure, type Guard } from "../../../../runtime/mod.ts";

const NOBODY = { _id: { $in: [] } };

export const rules: Guard = (actor, { collection, access, direct }) => {
  if (collection === "account" && direct && access === "write") {
    throw failure("forbidden", "Accounts change through their Actions.", { public: true });
  }
  return collection === "account"
    ? actor.kind === "person" ? { person: actor.id } : NOBODY
    : collection === "accountFlow" || collection === "modelKey"
    ? NOBODY
    : undefined;
};
