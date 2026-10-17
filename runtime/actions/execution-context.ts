/** Capability-only Action invocation assembly, shared by direct and worker hosts. */
import type { ContentStreamRuntime } from "../streams/index.ts";
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

type ActionInvocationHost = Pick<
  RuntimeContext,
  | "namespace"
  | "databaseSchema"
  | "resources"
  | "adapters"
  | "collections"
  | "vectors"
  | "content"
  | "streams"
  | "signal"
  | "signalDeferredWait"
  | "now"
  | "transaction"
  | "readSnapshot"
>;

/** Reserved stream metadata injected by the generic Action invocation host. */
const SOURCE_ACTION_RUN_ID_METADATA_KEY = "sourceActionRunId";

/** Adds invocation lifecycle state to the shared runtime context. */
export function createActionInvocationContext(
  options: Readonly<{
    host: ActionInvocationHost;
    frame: ActionInvocationFrame;
    actions: RuntimeActionCallers;
    progress(value: unknown): Promise<void>;
    registerDeferredWait(
      waitKey: string,
      timeoutMs?: number,
    ): Promise<void>;
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
  return (withProtectedEventResolver({
    ...host,
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
    registerDeferredWait: (waitKey, waitOptions) =>
      options.registerDeferredWait(waitKey, waitOptions?.timeoutMs),
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
    readSnapshot: (execute: Parameters<ActionContext["readSnapshot"]>[0]) =>
      host.readSnapshot(execute as never),
  }, protectedEventResolverFrom(host))) as ActionContext;
}
