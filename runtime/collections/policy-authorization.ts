import { ActionError, standardActionError } from "../actions/errors.ts";
import { withProtectedValueRead } from "../actions/protected-value-read.ts";
import { markOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { withOwnerReadQueryContext } from "../engine/owner-query-context.ts";
import {
  type OwnerCommandAuthorization,
  withOwnerAuthorizationPhase,
} from "../engine/command-authorization.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { CommandContext } from "../engine/commands.ts";
import type { CollectionRecord } from "./types.ts";
import type { CollectionPolicyIntent } from "./policy-types.ts";
import type { CollectionPolicyRegistration } from "./policy-registration.ts";
import {
  captureCollectionCommandInvocation,
  captureCollectionInvocation,
  type CollectionInvocationAuthority,
} from "./policy-invocation.ts";

type ReadScope = Readonly<{ transaction: SqlExecutor; commandTime: string }>;
type CommandPolicy = Readonly<{
  check(): void;
  authorize(
    read: ReadScope,
    phase: CollectionPolicyIntent["phase"],
    result?: unknown,
  ): Promise<void>;
}>;
export type CollectionPolicyOperation = Readonly<{
  registration: CollectionPolicyRegistration;
  namespace: string;
  databaseSchema: string;
  method: CollectionPolicyIntent["method"];
  args: unknown;
  current?(transaction: SqlExecutor): Promise<CollectionRecord | null>;
  next?: CollectionRecord | null;
  result?: unknown;
}>;
export function collectionPolicyRefused(permanent = true): never {
  // Planning and admitted policy failures must have the same public presentation.
  // Only owner-classified policy denial receives permanent cleanup authority.
  const error = standardActionError({ code: "forbidden", status: 403 })!;
  throw permanent ? markOwnerAuthorizationRefusal(error) : error;
}
function collectionPolicyUnavailable(): never {
  throw new Error("Collection authorization could not be completed.");
}
/** A disclosure refusal must never disguise an already committed mutation. */
export function collectionCommittedResultRefused(): never {
  throw Object.assign(
    new ActionError("Collection mutation committed; result access denied.", {
      code: "collection_result_denied_after_commit",
      status: 403,
    }),
    {
      commitOutcome: "committed",
    },
  );
}
/** Capture intent and owner authority synchronously before command admission. */
export function captureCollectionPolicy(
  operation: CollectionPolicyOperation,
  authority = captureCollectionInvocation(),
) {
  if (!authority) collectionPolicyRefused();
  const scope = authority.scope;
  if (
    scope.namespace !== operation.namespace ||
    scope.databaseSchema !== operation.databaseSchema
  ) collectionPolicyRefused();
  const intent = captureHostCommandJson({
    collection: {
      alias: operation.registration.alias,
      name: operation.registration.name,
    },
    method: operation.method,
    args: operation.args,
    ...(operation.next !== undefined ? { next: operation.next } : {}),
  }) as Omit<CollectionPolicyIntent, "phase" | "current">;
  const authorize = async (
    read: ReadScope,
    phase: CollectionPolicyIntent["phase"],
    result: unknown = operation.result,
    policyAuthority = authority,
  ) => {
    policyAuthority.check();
    await policyAuthority.assertCurrent?.(read, policyAuthority.invocation);
    let current: CollectionRecord | null | undefined;
    try {
      current = operation.current
        ? await operation.current!(read.transaction)
        : undefined;
    } catch {
      policyAuthority.check();
      collectionPolicyUnavailable();
    }
    let fixed: CollectionPolicyIntent;
    try {
      fixed = captureHostCommandJson({
        ...intent,
        phase,
        ...(phase === "result" && result !== undefined ? { result } : {}),
        ...(current !== undefined ? { current } : {}),
      }) as CollectionPolicyIntent;
    } catch {
      policyAuthority.check();
      collectionPolicyRefused();
    }
    await policyAuthority.authorizeIntent?.(fixed, read);
    await authorizeCollectionPolicy(
      operation.registration,
      policyAuthority,
      fixed,
      read,
    );
  };
  const forCommand = (command: CommandContext): CommandPolicy => {
    const invocation = captureCollectionCommandInvocation(authority, command);
    return {
      check: () => invocation.check(),
      authorize(read, phase, result = operation.result) {
        invocation.check(read);
        return authorize(read, phase, result, invocation);
      },
    };
  };
  const admitted = new WeakMap<SqlExecutor, CommandPolicy>();
  const guard: OwnerCommandAuthorization = (command, purpose) => {
    if (purpose === "mutation") {
      admitted.set(command.transaction, forCommand(command));
      return authorize(command, purpose);
    }
    const policy = admitted.get(command.transaction);
    if (!policy) throw new Error("Collection command policy was not admitted.");
    return policy.authorize(command, purpose);
  };
  return {
    check: () => authority.check(),
    authorize: (
      read: ReadScope,
      phase: CollectionPolicyIntent["phase"],
      result?: unknown,
    ) => authorize(read, phase, result),
    forCommand,
    guard,
  };
}
async function authorizeCollectionPolicy(
  registration: CollectionPolicyRegistration,
  authority: CollectionInvocationAuthority,
  intent: CollectionPolicyIntent,
  read: ReadScope,
): Promise<void> {
  // A failed owner query/source remains an infrastructure failure even if the
  // callback catches it and throws a policy-shaped error instead.
  let infrastructureFailed = false;
  const infrastructure = <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return run().catch((error) => {
        infrastructureFailed = true;
        throw error;
      });
    } catch (error) {
      infrastructureFailed = true;
      return Promise.reject(error);
    }
  };
  const transaction: SqlExecutor = {
    query: (sql, params) =>
      infrastructure(() => read.transaction.query(sql, params)),
  };
  try {
    await withOwnerAuthorizationPhase(() =>
      withOwnerReadQueryContext<
        void,
        Pick<
          import("./policy-types.ts").CollectionPolicyContext,
          "scope" | "invocation" | "resolveSource"
        >
      >(
        (context) => registration.policy.authorize(intent, context),
        { ...read, transaction },
        authority.signal,
        (assertActive, query, track) => ({
          scope: authority.scope,
          invocation: authority.invocation,
          resolveSource() {
            assertActive();
            const source = Object.freeze({ query });
            return track(
              infrastructure(() =>
                withProtectedValueRead(
                  source,
                  authority.scope,
                  authority.signal,
                  async () => {
                    assertActive();
                    authority.check();
                    await authority.assertCurrent?.(read, authority.invocation);
                    assertActive();
                    authority.check();
                  },
                  () => authority.resolveSource(source),
                )
              ),
            );
          },
        }),
      )
    );
  } catch (error) {
    authority.check();
    if (
      !infrastructureFailed && error instanceof ActionError &&
      error.code === "forbidden" && error.status === 403
    ) collectionPolicyRefused();
    collectionPolicyUnavailable();
  }
  authority.check();
}
