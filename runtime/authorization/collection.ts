import { captureCollectionCommandInvocation } from "./invocation-command.ts";
import { sameValue } from "../collections/equal.ts";
import { constrainCollection } from "./collection-constraints.ts";
import { authorizationRefused } from "./evaluator.ts";
import { ActionError, standardActionError } from "../actions/errors.ts";
import { markOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import type {
  OwnerCommandAuthorization,
} from "../engine/command-authorization.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { CommandContext } from "../engine/commands.ts";
import type { CollectionRecord } from "../collections/types.ts";
import type { CollectionPolicyIntent } from "./intent.ts";
import type { CollectionPolicyRegistration } from "./resources.ts";
import { captureCollectionInvocation } from "./invocation.ts";

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
  expectedArgs?: unknown;
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
  // Optional call fields such as `{ after: undefined }` are absent. The policy
  // judges, and the kernel executes, exactly these captured arguments.
  const intent = captureHostCommandJson({
    collection: {
      alias: operation.registration.alias,
      name: operation.registration.name,
    },
    method: operation.method,
    args: operation.args,
    ...(operation.next !== undefined ? { next: operation.next } : {}),
  }, { omitUndefinedProperties: true }) as Omit<
    CollectionPolicyIntent,
    "phase" | "current"
  >;
  let authorizedArgs: unknown = intent.args;
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
    if (policyAuthority.trustedHost) return;
    let binding = policyAuthority.authority;
    if (!binding) {
      const source = await policyAuthority.resolveSource(read.transaction);
      binding = source.ingress?.authority ??
        source.ancestors.find((entry) => entry.ingress?.authority)?.ingress
          ?.authority;
      if (!binding && source.ingress?.kind === "host") return;
    }
    if (!binding) authorizationRefused();
    const decision = await operation.registration.evaluate(binding, {
      kind: "collection",
      resource: operation.registration.alias,
      operation: operation.method,
      input: fixed,
      ...(policyAuthority.sourceEventId
        ? { sourceEventId: policyAuthority.sourceEventId }
        : {}),
      ...(policyAuthority.sourceDeliveryId
        ? { sourceDeliveryId: policyAuthority.sourceDeliveryId }
        : {}),
      ...(!policyAuthority.direct
        ? {
          invocation: {
            kind: policyAuthority.invocation.kind,
            id: policyAuthority.invocation.id,
            runId: policyAuthority.invocation.runId,
          },
        }
        : {}),
    }, { ...read, signal: policyAuthority.signal });
    authorizedArgs = constrainCollection(fixed, decision.constraints);
    if (
      operation.expectedArgs !== undefined &&
      !sameValue(authorizedArgs, operation.expectedArgs)
    ) authorizationRefused();
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
    args: () => authorizedArgs,
    authorize: (
      read: ReadScope,
      phase: CollectionPolicyIntent["phase"],
      result?: unknown,
    ) => authorize(read, phase, result),
    forCommand,
    guard,
  };
}
