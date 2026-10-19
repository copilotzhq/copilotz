/** Revocable query-only authority for trusted owner-local policy/storage phases. */
import { bindCommandExecutorAlias, type CommandContext } from "./commands.ts";
import type { SqlExecutor } from "../events/session.ts";

async function withQueryContext<T, Fields extends object>(
  run: (
    context: Readonly<
      Fields & {
        query: SqlExecutor["query"];
        commandTime: string;
        signal: AbortSignal;
      }
    >,
  ) => T | Promise<T>,
  command: Pick<CommandContext, "transaction" | "commandTime">,
  signal: AbortSignal,
  fields: (
    assertActive: () => void,
    query: SqlExecutor["query"],
    track: <V>(promise: Promise<V>) => Promise<V>,
  ) => Fields,
  bind?: (context: object, assertActive: () => void) => void,
): Promise<T> {
  let active = true;
  let pending = 0;
  let queryFailed = false;
  let queryError: unknown;
  let drained: (() => void) | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    if (!active) throw new Error("Owner query handle is closed.");
  };
  const track = <V>(promise: Promise<V>): Promise<V> => {
    pending++;
    void promise.then(() => {
      if (--pending === 0) drained?.();
    }, (error) => {
      if (!queryFailed) {
        queryFailed = true;
        queryError = error;
      }
      if (--pending === 0) drained?.();
    });
    return promise;
  };
  const query: SqlExecutor["query"] = <Row extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    try {
      assertActive();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = command.transaction.query<Row>(sql, params).then(
      (result) => {
        signal.throwIfAborted();
        return result;
      },
    );
    return track(result);
  };
  let value: T | undefined;
  let failed = false;
  let failure: unknown;
  try {
    assertActive();
    const context = Object.freeze(Object.defineProperties(
      {
        query,
        commandTime: command.commandTime,
        signal,
      },
      Object.getOwnPropertyDescriptors(fields(assertActive, query, track)),
    )) as Readonly<
      Fields & {
        query: SqlExecutor["query"];
        commandTime: string;
        signal: AbortSignal;
      }
    >;
    bind?.(context, assertActive);
    const result = run(context);
    // Revoke synchronous returns before their queued microtasks run.
    value = result instanceof Promise ? await result : result;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    active = false;
  }
  if (pending) {
    await new Promise<void>((resolve) => {
      drained = resolve;
    });
  }
  signal.throwIfAborted();
  if (failed) throw failure;
  if (queryFailed) throw queryError;
  return value as T;
}

type QueryFields<Fields extends object> = (
  assertActive: () => void,
  query: SqlExecutor["query"],
  track: <V>(promise: Promise<V>) => Promise<V>,
) => Fields;
type QueryCallback<T, Fields extends object> = (
  context: Readonly<
    Fields & {
      query: SqlExecutor["query"];
      commandTime: string;
      signal: AbortSignal;
    }
  >,
) => T | Promise<T>;

/** Current owner command authority, including its revocable transaction alias. */
export function withOwnerQueryContext<T, Fields extends object>(
  run: QueryCallback<T, Fields>,
  command: CommandContext,
  signal: AbortSignal,
  fields: QueryFields<Fields>,
): Promise<T> {
  return withQueryContext(
    run,
    command,
    signal,
    fields,
    (context, assertActive) =>
      bindCommandExecutorAlias(
        context as SqlExecutor,
        command.transaction,
        assertActive,
      ),
  );
}

/** Read-only policy scope; deliberately cannot be reused as a command executor. */
export function withOwnerReadQueryContext<T, Fields extends object>(
  run: QueryCallback<T, Fields>,
  read: Readonly<{ transaction: SqlExecutor; commandTime: string }>,
  signal: AbortSignal,
  fields: QueryFields<Fields>,
): Promise<T> {
  return withQueryContext(run, read, signal, fields);
}
