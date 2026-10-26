import { bindActionCollectionInvocation } from "../authorization/invocation.ts";
/** Capability-only Action assembly used by the sole owner invocation kernel. */
import { fail as effectFailure } from "./effect-client.ts";
import { awaitOperation } from "./continuation.ts";
import type { ContentStreamRuntime } from "../streams/types.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import type {
  ActionContext,
  ActionTransactionOptions,
  RuntimeActionCallers,
  RuntimeContext,
} from "./types.ts";
import { actionTransactionIdentity } from "./transaction-identity.ts";
import {
  protectedEventResolverFrom,
  withProtectedEventResolver,
} from "./protected-context.ts";
type ActionInvocationHost =
  & Pick<
    RuntimeContext,
    | "namespace"
    | "databaseSchema"
    | "resources"
    | "adapters"
    | "collections"
    | "vectors"
    | "content"
    | "streams"
    | "operations"
    | "signal"
    | "now"
    | "transaction"
  >
  & Partial<Pick<RuntimeContext, "directory" | "authentication">>
  & { read: import("../collections/reads.ts").OwnerRead };

/** Reserved stream metadata injected by the generic Action invocation host. */
const SOURCE_ACTION_RUN_ID_METADATA_KEY = "sourceActionRunId";

/** Adds invocation lifecycle state to the shared runtime context. */
const unavailable = () =>
  Promise.reject(effectFailure(
    "effect_unavailable",
    "An owner-bound effect capability is required.",
  ));
const unavailableEffects = Object.freeze({
  begin: unavailable,
  inspect: unavailable,
  confirm: unavailable,
  notStarted: unavailable,
});

export function createActionInvocationContext(
  options: Readonly<{
    host: ActionInvocationHost;
    frame: ActionInvocationFrame;
    actions: RuntimeActionCallers;
    progress(value: unknown): Promise<void>;
  }>,
): ActionContext {
  const { frame, host } = options;
  let transactionIndex = 0;
  const streams: ContentStreamRuntime = {
    ...host.streams,
    open(input, openOptions) {
      return host.streams.open({
        ...input,
        metadata: {
          ...input.metadata,
          [SOURCE_ACTION_RUN_ID_METADATA_KEY]: frame.actionRunId,
        },
      }, openOptions);
    },
  } as const;
  const content = {
    ...host.content,
    capture(
      input: Parameters<typeof host.content.capture>[0],
      captureOptions: Parameters<typeof host.content.capture>[1],
    ) {
      return host.content.capture(input, {
        ...captureOptions,
        operationKey: `${frame.operationKey}/${captureOptions.operationKey}`,
      });
    },
    openCapture(input: Parameters<typeof host.content.openCapture>[0]) {
      return host.content.openCapture({
        ...input,
        operationKey: `${frame.operationKey}/${input.operationKey}`,
      });
    },
    prepare(
      input: Parameters<typeof host.content.prepare>[0],
      prepareOptions: Parameters<typeof host.content.prepare>[1],
    ) {
      return host.content.prepare(input, {
        ...prepareOptions,
        operationKey: `${frame.operationKey}/${prepareOptions.operationKey}`,
      });
    },
    publish(
      input: Parameters<typeof host.content.publish>[0],
      publishOptions: Parameters<typeof host.content.publish>[1],
    ) {
      return host.content.publish(input, {
        ...publishOptions,
        operationKey: `${frame.operationKey}/${publishOptions.operationKey}`,
      });
    },
  } as const;
  return bindActionCollectionInvocation(
    withProtectedEventResolver({
      ...host,
      directory: host.directory ?? { get: unavailable, command: unavailable },
      authentication: host.authentication ?? { verify: unavailable },
      action: {
        id: frame.actionId,
        runId: frame.actionRunId,
        metadata: frame.metadata,
        ...(frame.parentActionRunId
          ? { parentRunId: frame.parentActionRunId }
          : {}),
      } as const,
      operationKey: frame.operationKey,
      identity: { ...(frame.identity ?? {}) } as const,
      actions: options.actions,
      content,
      streams,
      signal: frame.signal,
      progress: options.progress,
      awaitOperation,
      effect: unavailableEffects,
      transaction: (
        execute: Parameters<ActionContext["transaction"]>[0],
        transactionOptions: ActionTransactionOptions = {},
      ) => {
        const localKey = transactionOptions.operationKey?.trim() ||
          `transaction:${++transactionIndex}`;
        const identity = actionTransactionIdentity(
          frame.identity,
          transactionOptions.identity,
        );
        return host.transaction(execute as never, {
          ...transactionOptions,
          operationKey: `${frame.operationKey}/${localKey}`,
          ...(identity ? { identity } : {}),
          signal: transactionOptions.signal ?? frame.signal,
        }) as never;
      },
      read: (name, args, config) =>
        host.read(name, args, {
          ...config,
          signal: config?.signal ?? frame.signal,
        }, {
          operationKey: frame.operationKey,
          identity: frame.identity ?? {},
          signal: frame.signal,
        }),
    }, protectedEventResolverFrom(host)),
    host,
    frame,
  ) as ActionContext;
}
