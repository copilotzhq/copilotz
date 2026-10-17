import type { CollectionDefinition } from "../collections/definition.ts";
import type { CollectionMutationRef } from "../collections/types.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import { assertJsonValue } from "../json.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
} from "./boundary.ts";
import type { OwnerCollectionOperation } from "./collections.ts";

type PlannedCollection = Readonly<{
  create(
    input: Readonly<Record<string, unknown>>,
  ): Promise<CollectionMutationRef>;
  update(
    input: Readonly<Record<string, unknown> & { id: string }>,
  ): Promise<CollectionMutationRef>;
  delete(input: Readonly<{ id: string }>): Promise<CollectionMutationRef>;
  commands: Readonly<
    Record<
      string,
      (
        input: Readonly<Record<string, unknown> & { id: string }>,
      ) => Promise<CollectionMutationRef>
    >
  >;
}>;
export type OwnerTransactionContext<C> = Readonly<{
  collections: { readonly [K in keyof C]: PlannedCollection };
}>;

/** Private JSON-Collection planner. Only ID references are planning results;
 * records, reads, mutate outcomes, relations, vectors and content are not local
 * results. Callback code runs again on replay and must not perform effects.
 * Both direct and connected ports use this exact planner; arbitrary callback T
 * is local computation and is never serialized or included in receipt intent. */
export function createOwnerTransactionPlanner<
  const C extends Readonly<Record<string, CollectionDefinition>>,
>(
  options: Readonly<{
    collections: C;
    /** Stable host-assigned identity, not a transient connection or owner epoch. */
    identity: Readonly<
      { ownerId: string; workerId: string; invocationId: string }
    >;
    execute(
      command: OwnerCommand,
      options?: OwnerCommandExecuteOptions,
    ): Promise<OwnerCommandOutcome>;
    maxOperations?: number;
  }>,
) {
  const identity = {
    ownerId: options.identity?.ownerId,
    workerId: options.identity?.workerId,
    invocationId: options.identity?.invocationId,
  };
  if (
    Object.values(identity).some((value) =>
      typeof value !== "string" || !value.trim()
    )
  ) {
    throw new TypeError(
      "Stable owner, worker and invocation identities are required.",
    );
  }
  const registrations = Object.entries(options.collections).map((
    [alias, definition],
  ) => ({
    alias,
    content: Boolean(definition.content?.fields.length),
    commands: Object.keys(definition.commands ?? {}),
  }));
  const execute = options.execute;
  const limit = options.maxOperations ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("maxOperations must be positive.");
  }
  return async function transaction<T>(
    input: Readonly<{
      /** Fully scoped logical key; owner authorization binds it to the admitted invocation. */
      operationKey: string;
      execute(context: OwnerTransactionContext<C>): T | Promise<T>;
      signal?: AbortSignal;
    }>,
  ): Promise<Readonly<{ value: T; outcome: OwnerCommandOutcome }>> {
    if (typeof input.operationKey !== "string" || !input.operationKey.trim()) {
      throw new TypeError("Transaction operationKey is required.");
    }
    const key = input.operationKey;
    const signal = input.signal;
    let cancelled = signal?.aborted ?? false;
    let reason = signal?.reason;
    const onAbort = () => {
      cancelled = true;
      reason = signal?.reason;
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let active = true;
    let failed = false;
    let firstError: unknown;
    const operations: OwnerCollectionOperation[] = [];
    const pending: Promise<unknown>[] = [];
    const check = () => {
      if (cancelled) {
        throw reason ??
          new DOMException("Transaction cancelled.", "AbortError");
      }
      if (!active) throw new Error("Transaction planning context is closed.");
    };
    const unsupported = (): never => {
      const error = new TypeError(
        "Capability is not supported by the JSON owner transaction planner.",
      );
      if (!failed) {
        failed = true;
        firstError = error;
      }
      throw error;
    };
    const plan = (
      alias: string,
      content: boolean,
      operation: OwnerCollectionOperation["operation"],
      data: unknown,
      command?: string,
      callOptions?: unknown,
    ): Promise<CollectionMutationRef> => {
      const task = (async () => {
        check();
        if (content || callOptions !== undefined) return unsupported();
        assertJsonValue(data, {
          maxDepth: 64,
          maxNodes: 100_000,
          rejectNegativeZero: true,
        });
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new TypeError("Collection input must be a JSON object.");
        }
        const copied = structuredClone(data) as Record<string, OwnerJson>;
        const index = operations.length;
        if (index >= limit) {
          throw new RangeError("Transaction exceeds operation bound.");
        }
        // Reserve ordered slots before asynchronous ID derivation so concurrent
        // calls preserve invocation order, not crypto completion order.
        const entry = {
          collection: alias,
          operation,
          input: copied,
          ...(command ? { command } : {}),
        };
        operations.push(entry);
        if (copied.id === undefined && operation === "create") {
          copied.id = await deriveWorkflowId(
            "record",
            JSON.stringify([
              identity.ownerId,
              identity.invocationId,
              key,
              index,
              alias,
            ]),
          );
        }
        if (typeof copied.id !== "string" || !copied.id.trim()) {
          throw new TypeError("A non-empty record ID is required.");
        }
        return { id: copied.id };
      })();
      pending.push(task.catch((error) => {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }));
      return task;
    };
    const collections = Object.fromEntries(
      registrations.map(({ alias, content, commands }) => {
        const methods = {
          create: (data: unknown, extra?: unknown) =>
            plan(alias, content, "create", data, undefined, extra),
          update: (data: unknown, extra?: unknown) =>
            plan(alias, content, "update", data, undefined, extra),
          delete: (data: unknown, extra?: unknown) =>
            plan(alias, content, "delete", data, undefined, extra),
          commands: new Proxy(
            Object.fromEntries(
              commands.map((
                command,
              ) => [
                command,
                (data: unknown, extra?: unknown) =>
                  plan(alias, content, "command", data, command, extra),
              ]),
            ),
            {
              get(target, property) {
                return Object.hasOwn(target, property)
                  ? Reflect.get(target, property)
                  : unsupported;
              },
            },
          ),
        };
        return [
          alias,
          new Proxy(methods, {
            get(target, property) {
              return Object.hasOwn(target, property)
                ? Reflect.get(target, property)
                : unsupported;
            },
          }),
        ];
      }),
    );
    try {
      check();
      const value = await input.execute(
        { collections } as OwnerTransactionContext<C>,
      );
      active = false;
      await Promise.all(pending);
      if (cancelled) {
        throw reason ??
          new DOMException("Transaction cancelled.", "AbortError");
      }
      if (failed) throw firstError;
      const outcome = await execute({
        kind: "collections",
        domain: "logical",
        key,
        intent: { operations } as unknown as OwnerJson,
      }, { signal });
      return { value, outcome };
    } finally {
      active = false;
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
