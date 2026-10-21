/** Owner-only command binding, excluded from worker artifacts. */
import {
  type CommandContext,
  schemaCommandContext,
} from "../engine/commands.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { CollectionPolicyInvocation } from "./intent.ts";
import {
  type CollectionInvocationAuthority,
  collectionInvocationOwner,
} from "./invocation.ts";
function closed(): never {
  throw Object.assign(new Error("Collection invocation authority has ended."), {
    code: "ActionOwnershipLost",
  });
}
/** A live call may contribute read-only policy to this exact owner command. */
export function captureCollectionCommandInvocation(
  authority: CollectionInvocationAuthority,
  command: CommandContext,
) {
  authority.check();
  const owner = collectionInvocationOwner(authority);
  const scope = Object.freeze({ ...owner.scope });
  const invocation = captureHostCommandJson(
    owner.invocation,
  ) as CollectionPolicyInvocation;
  const canonical = schemaCommandContext(
    command.transaction,
    scope.databaseSchema,
  );
  return Object.freeze({
    ...owner,
    scope,
    invocation,
    check(
      read: Readonly<{ transaction: SqlExecutor; commandTime: string }> =
        canonical,
    ) {
      if (
        schemaCommandContext(read.transaction, scope.databaseSchema) !==
          canonical || read.commandTime !== canonical.commandTime
      ) closed();
      canonical.signal.throwIfAborted();
      owner.signal.throwIfAborted();
      owner.check();
    },
  });
}
