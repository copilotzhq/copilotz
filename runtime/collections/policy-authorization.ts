import { ActionError } from "../actions/errors.ts";
import { withProtectedValueRead } from "../actions/protected-value-read.ts";
import { withCollectionReadBudget } from "./read-budget.ts";
import { markOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { withOwnerReadQueryContext } from "../engine/owner-query-context.ts";
import {
  type OwnerCommandAuthorization,
  withOwnerAuthorizationPhase,
} from "../engine/command-authorization.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { CollectionRecord } from "./types.ts";
import type { CollectionPolicyIntent } from "./policy-types.ts";
import type { CollectionPolicyRegistration } from "./policy-registration.ts";
import {
  captureCollectionInvocation,
  type CollectionInvocationAuthority,
} from "./policy-invocation.ts";

type ReadScope = Readonly<{ transaction: SqlExecutor; commandTime: string }>;
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
  const error = new ActionError("Collection access denied.", {
    code: "forbidden",
    status: 403,
  });
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
  ) => {
    authority.check();
    await authority.assertCurrent?.(read, authority.invocation);
    let current: CollectionRecord | null | undefined;
    try {
      current = operation.current
        ? await withCollectionReadBudget(() =>
          operation.current!(read.transaction)
        )
        : undefined;
    } catch {
      authority.check();
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
      authority.check();
      collectionPolicyRefused();
    }
    await authority.authorizeIntent?.(fixed, read);
    await authorizeCollectionPolicy(
      operation.registration,
      authority,
      fixed,
      read,
    );
  };
  return {
    check: () => authority.check(),
    authorize,
    guard:
      ((command, purpose) =>
        authorize(command, purpose)) as OwnerCommandAuthorization,
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
