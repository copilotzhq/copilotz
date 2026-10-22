import { captureWorkerContent, type CaptureWriter } from "./owner-capture.ts";
import { resolveDeliveryTimeoutMs } from "./deadlines.ts";
import {
  bindWorkerCollectionInvocation,
  closeCollectionPolicyInvocation,
  withContextCollectionInvocation,
} from "../authorization/invocation.ts";
import { standardActionError } from "../actions/errors.ts";
/** The single worker execution path for in-process and WebSocket placement. */
import type { WorkerWorkHandler } from "../../dependencies/oxian-worker.ts";
import { isHostCallError } from "../../dependencies/oxian-work.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { awaitOperation } from "../actions/continuation.ts";
import { recordActionCaller } from "../actions/caller-identity.ts";
import { withProtectedEventResolver } from "../actions/protected-context.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import {
  type CapabilityCall,
  capabilityError,
  type CapabilityInvocation,
  type CapabilityPath,
  type CapabilityPoll,
  decodeCapability,
  encodeCapability,
  OWNER_CAPABILITY_BYTES,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "./owner-capability-wire.ts";

type Method = (...args: unknown[]) => unknown;
type RecordValue = Record<string, unknown>;
type Request = (call: CapabilityCall, signal?: AbortSignal) => Promise<unknown>;
const MAX_ACTIVE_INVOCATIONS = 256;
function authorizationRefused(): never {
  throw standardActionError({ code: "forbidden", status: 403 })!;
}

function signalFrom(args: readonly unknown[]): AbortSignal | undefined {
  for (const argument of args) {
    if (argument && typeof argument === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(argument, "signal");
      if (descriptor && !("value" in descriptor)) {
        throw capabilityError("owner_data_invalid");
      }
      if (descriptor?.value instanceof AbortSignal) return descriptor.value;
    }
  }
}
function cleanArgs(args: readonly unknown[]): readonly unknown[] {
  return args.map((argument) => {
    if (
      !argument || typeof argument !== "object" ||
      !Object.hasOwn(argument, "signal")
    ) return argument;
    const result: RecordValue = {};
    for (const key of Reflect.ownKeys(argument)) {
      const descriptor = Object.getOwnPropertyDescriptor(argument, key)!;
      if (typeof key !== "string" || !("value" in descriptor)) {
        throw capabilityError("owner_data_invalid");
      }
      if (key !== "signal") {
        Object.defineProperty(result, key, {
          value: descriptor.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return result;
  });
}
function methods(
  names: readonly string[],
  call: (name: string, args: readonly unknown[]) => Promise<unknown>,
): RecordValue {
  return Object.fromEntries(
    names.map((name) => [name, (...args: unknown[]) => call(name, args)]),
  );
}

/** Data-only metadata and methods; it has no persistence option or import. */
function workerContext(options: {
  invocation: CapabilityInvocation;
  registry: PluginRegistry;
  request: Request;
  signal: AbortSignal;
  factories: Map<string, () => unknown>;
}) {
  const { invocation, registry, request, signal } = options;
  // This is an observational clock, never a persistence/lease authority. Sample
  // owner time once and advance it with local monotonic elapsed time.
  const ownerTime = Date.parse(String(invocation.scope.now));
  const sampledAt = performance.now();
  const pending = new Set<Promise<unknown>>();
  let stopped = false;
  let fatal: unknown;
  let transactionIndex = 0;
  const check = () => {
    signal.throwIfAborted();
    if (stopped) throw capabilityError("owner_context_closed");
  };
  const track = <T>(run: () => Promise<T>): Promise<T> => {
    check();
    const promise = run();
    pending.add(promise);
    void promise.then(() => pending.delete(promise), (error) => {
      pending.delete(promise);
      if (
        isHostCallError(error) && error.execution === "indeterminate" ||
        (error as { code?: unknown })?.code === "owner_call_indeterminate" ||
        [
          "ActionOwnershipLost",
          "owner_cleanup_unknown",
          "owner_handle_expired",
          "owner_commit_unknown",
          "persistence_indeterminate",
        ].includes(String((error as { code?: unknown })?.code))
      ) fatal = error;
    });
    return promise;
  };
  const rpc = (path: CapabilityPath, args: readonly unknown[], id?: string) =>
    track(async () => {
      const result = await request({
        kind: "call",
        context: invocation.context,
        path,
        args: cleanArgs(args),
        ...(id ? { id } : {}),
      }, signalFrom(args) ?? signal);
      check();
      return hydrate(result);
    });
  const close = (id: string, error?: unknown) =>
    track(() =>
      request({
        kind: "close",
        context: invocation.context,
        id,
        ...(error !== undefined ? { error } : {}),
      }, signal)
    );
  const hydrate = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const resource = value as RecordValue;
    if (
      resource.$ownerResource === "reader" &&
      typeof resource.handle === "string"
    ) {
      const handle = resource.handle;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await rpc(
              ["read"],
              [],
              handle,
            ) as ReadableStreamReadResult<Uint8Array>;
            if (next.done) {
              await close(handle);
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel(reason) {
          await close(handle, reason instanceof Error ? reason : undefined);
        },
      });
    }
    if (
      resource.$ownerResource === "writer" &&
      typeof resource.handle === "string"
    ) {
      const handle = resource.handle;
      let offset = Number(resource.offset);
      const retainAfterClose = resource.retainAfterClose === true;
      let sealed = false;
      let closed = false;
      let pendingAppends = 0;
      const guard = () => {
        check();
        if (closed) throw capabilityError("owner_handle_closed");
      };
      const writeGuard = () => {
        guard();
        if (sealed) throw capabilityError("owner_handle_closed");
      };
      return {
        id: resource.id,
        offset: () => offset,
        async append(...args: unknown[]) {
          writeGuard();
          if (pendingAppends >= 2) {
            throw capabilityError("owner_append_capacity");
          }
          // Reject before rpc snapshots/encodes bytes or tracks another call.
          pendingAppends++;
          try {
            const result = await rpc(["append"], args, handle) as {
              endOffset: number;
            };
            offset = result.endOffset;
            return result;
          } finally {
            pendingAppends--;
          }
        },
        async close(...args: unknown[]) {
          writeGuard();
          const result = await rpc(["close"], args, handle);
          sealed = true;
          // Capture-only handles end at close. Stream bodies are sealed, but
          // their bounded retain capability lives until explicit disposal.
          closed = !retainAfterClose;
          return result;
        },
        async abort(...args: unknown[]) {
          if (closed || sealed) return;
          await rpc(["abort"], args, handle);
          closed = true;
        },
        async retain(...args: unknown[]) {
          guard();
          if (!sealed || !retainAfterClose) {
            throw capabilityError("owner_handle_not_sealed");
          }
          return await rpc(["retain"], args, handle);
        },
        async [Symbol.asyncDispose]() {
          if (!closed) {
            await close(handle);
            closed = true;
          }
        },
      };
    }
    if (
      resource.body && typeof resource.body === "object" &&
      (resource.body as RecordValue).$ownerResource === "reader"
    ) return { ...resource, body: hydrate(resource.body) };
    return value;
  };
  const collections = (id?: string): RecordValue =>
    Object.fromEntries(
      Object.entries(registry.collections).map((
        [alias, definition],
      ) => [alias, {
        definition: {
          name: definition.name,
          schema: definition.schema,
          relations: definition.relations,
        },
        ...methods([
          "get",
          "list",
          "aggregate",
          "search",
          ...(!id ? ["create", "update", "delete"] : []),
        ], (name, args) => rpc(["collections", alias, name], args, id)),
        queries: methods(
          Object.keys(definition.queries ?? {}),
          (name, args) =>
            rpc(["collections", alias, "queries", name], args, id),
        ),
        commands: !id
          ? methods(
            Object.keys(definition.commands ?? {}),
            (name, args) => rpc(["collections", alias, "commands", name], args),
          )
          : undefined,
        relations: {
          list: (...args: unknown[]) =>
            rpc(["collections", alias, "relations", "list"], args, id),
        },
      }]),
    );
  const transaction = async <T>(
    execute: (context: unknown) => T | Promise<T>,
    transactionOptions: RecordValue = {},
  ): Promise<T> => {
    check();
    const callSignal = signalFrom([transactionOptions]);
    const transactionSignal = callSignal
      ? AbortSignal.any([signal, callSignal])
      : signal;
    transactionSignal.throwIfAborted();
    transactionOptions = decodeCapability(
      encodeCapability(cleanArgs([transactionOptions])[0]),
    ) as RecordValue;
    const key = typeof transactionOptions.operationKey === "string"
      ? transactionOptions.operationKey
      : `transaction:${++transactionIndex}`;
    const plan: Array<{ path: CapabilityPath; args: unknown[] }> = [];
    const planning: Promise<unknown>[] = [];
    let active = true;
    let failure: unknown;
    const stage = (path: CapabilityPath, args: unknown[]): Promise<unknown> => {
      const task = (async () => {
        check();
        if (!active) throw capabilityError("owner_plan_closed");
        transactionSignal.throwIfAborted();
        if (plan.length >= 100) throw capabilityError("owner_plan_limit");
        const index = plan.length;
        // Snapshot synchronously so mutation after scheduling cannot change intent.
        const copied = decodeCapability(
          encodeCapability(cleanArgs(args)),
        ) as unknown[];
        const entry = { path: [...path], args: copied };
        plan.push(entry);
        if (["vectors", "sessions", "flows", "directory"].includes(path[0])) {
          return undefined;
        }
        const input = copied[0] as RecordValue;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw capabilityError("owner_plan_invalid");
        }
        if (
          input.id === undefined &&
          (path.at(-1) === "create" || path[0] === "relations")
        ) {
          input.id = await deriveWorkflowId(
            "record",
            JSON.stringify([
              invocation.scope.namespace,
              invocation.scope.operationKey,
              key,
              index,
              path,
            ]),
          );
        }
        if (typeof input.id !== "string" || !input.id.trim()) {
          throw capabilityError("owner_plan_invalid");
        }
        return { id: input.id };
      })();
      planning.push(task.catch((error) => {
        failure ??= error;
      }));
      return task;
    };
    const scoped = {
      directory: {
        command: (...args: unknown[]) => stage(["directory", "command"], args),
      },
      sessions: {
        create: (...args: unknown[]) => stage(["sessions", "create"], args),
        revoke: (...args: unknown[]) => stage(["sessions", "revoke"], args),
      },
      flows: { start: (...args: unknown[]) => stage(["flows", "start"], args) },
      collections: Object.fromEntries(
        Object.entries(registry.collections).map((
          [alias, definition],
        ) => [alias, {
          ...Object.fromEntries(
            ["create", "update", "delete"].map((
              name,
            ) => [
              name,
              (...args: unknown[]) => stage(["collections", alias, name], args),
            ]),
          ),
          commands: Object.fromEntries(
            Object.keys(definition.commands ?? {}).map((
              name,
            ) => [
              name,
              (...args: unknown[]) =>
                stage(["collections", alias, "commands", name], args),
            ]),
          ),
        }]),
      ),
      relations: {
        upsert: (...args: unknown[]) => stage(["relations", "upsert"], args),
      },
      vectors: {
        upsert: (...args: unknown[]) => stage(["vectors", "upsert"], args),
      },
    };
    let value: T;
    try {
      value = await execute(scoped);
    } finally {
      active = false;
      await Promise.all(planning);
    }
    if (failure) throw failure;
    check();
    transactionSignal.throwIfAborted();
    const wireOptions = transactionOptions;
    const ownerOptions = { ...wireOptions, operationKey: key };
    const receipt = {
      key: JSON.stringify([
        invocation.scope.namespace,
        invocation.scope.operationKey,
        key,
      ]),
      databaseSchema: String(invocation.scope.databaseSchema),
    };
    await track(() =>
      request(
        {
          kind: "transaction",
          context: invocation.context,
          plan,
          options: ownerOptions,
          receipt,
        },
        transactionSignal,
      )
    );
    check();
    transactionSignal.throwIfAborted();
    return value;
  };
  const readSnapshot = async <T>(
    execute: (context: unknown) => T | Promise<T>,
  ): Promise<T> => {
    const opened = await track(() =>
      request({ kind: "snapshot", context: invocation.context }, signal)
    ) as { handle: string };
    let error: unknown;
    let value: T;
    try {
      value = await execute({ collections: collections(opened.handle) });
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      await close(opened.handle, error);
    }
    check();
    return value;
  };
  const actions = Object.fromEntries(
    Object.entries(registry.actions).map(([alias, definition]) => {
      const caller = Object.assign(
        (...args: unknown[]) => rpc(["actions", alias], args),
        {
          async prepare(factory: () => unknown, prepareOptions: RecordValue) {
            check();
            if (typeof factory !== "function") {
              throw new TypeError("Action prepare requires a factory.");
            }
            const token = crypto.randomUUID();
            options.factories.set(token, factory);
            try {
              return await rpc(["actions", alias, "prepare"], [
                token,
                prepareOptions,
              ]);
            } finally {
              options.factories.delete(token);
            }
          },
        },
      );
      recordActionCaller(caller, definition.id);
      return [alias, caller];
    }),
  );
  const rawContext = withProtectedEventResolver({
    ...invocation.scope,
    resources: registry.resources,
    adapters: registry.adapters,
    actions,
    collections: collections(),
    authentication: {
      verify: (...args: unknown[]) => rpc(["authentication", "verify"], args),
    },
    directory: {
      get: (...args: unknown[]) => rpc(["directory", "get"], args),
      command: (...args: unknown[]) => rpc(["directory", "command"], args),
    },
    content: {
      ...methods([
        "authorize",
        "prepare",
        "openCapture",
        "materialize",
        "publish",
        "get",
        "getMany",
        "resolve",
        "resolveMany",
        "open",
      ], (name, args) => rpc(["content", name], args)),
      capture: (input: unknown, options: unknown) =>
        track(() =>
          captureWorkerContent(input, options, {
            namespace: String(invocation.scope.namespace),
            signal,
            open: async (value) =>
              await rpc(["content", "openCapture"], [value]) as CaptureWriter,
            reference: async (value, options) =>
              await rpc(["content", "capture"], [
                value,
                options,
              ]) as readonly unknown[],
          })
        ),
    },
    streams: methods(
      ["open", "follow"],
      (name, args) => rpc(["streams", name], args),
    ),
    vectors: {
      search: (...args: unknown[]) => rpc(["vectors", "search"], args),
    },
    operations: {
      start: (...args: unknown[]) => rpc(["operations", "start"], args),
    },
    effect: methods(
      [
        "begin",
        "inspect",
        "confirm",
        "notStarted",
        "inventory",
      ],
      (name, args) => rpc(["effect", name], args),
    ),
    progress: (...args: unknown[]) => rpc(["progress"], args),
    awaitOperation,
    signal,
    now: () => new Date(ownerTime + Math.max(0, performance.now() - sampledAt)),
    transaction,
    readSnapshot,
  }, () => rpc(["protectedEvent"], []));
  const scope = {
    databaseSchema: String(invocation.scope.databaseSchema),
    namespace: String(invocation.scope.namespace),
  };
  const action = invocation.scope.action as
    | { id: string; runId: string; parentRunId?: string }
    | undefined;
  const context = bindWorkerCollectionInvocation(
    rawContext,
    {
      scope,
      signal,
      resolveSource: () =>
        Promise.reject(capabilityError("owner_source_required")),
      callHostCapability(path, args, destination) {
        check();
        if (
          destination.databaseSchema !== scope.databaseSchema ||
          destination.namespace !== scope.namespace
        ) authorizationRefused();
        const input = (args[1] ?? {}) as RecordValue;
        const translated: RecordValue = {};
        for (const [key, value] of Object.entries(input)) {
          if (key === "databaseSchema" || key === "namespace") continue;
          if (!["idempotencyKey", "metadata", "signal"].includes(key)) {
            authorizationRefused();
          }
          translated[key === "idempotencyKey" ? "operationKey" : key] = value;
        }
        return rpc(path, [args[0], translated]);
      },
    },
    action
      ? { kind: "action", ...action }
      : { kind: "processor", id: invocation.alias, runId: invocation.context },
  );
  return {
    context,
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
      if (fatal) throw fatal;
    },
    stop() {
      stopped = true;
      closeCollectionPolicyInvocation(context);
    },
  };
}

export function createOwnerWorkerWorkloads(
  options: Readonly<{
    registry: PluginRegistry;
    workloads?: readonly string[];
    deliveryTimeoutMs?: number;
  }>,
): Readonly<Record<string, WorkerWorkHandler>> {
  const deliveryTimeoutMs = resolveDeliveryTimeoutMs(
    options.deliveryTimeoutMs,
    options.registry.actions,
  );
  const execute: WorkerWorkHandler = async (work) => {
    const abort = new AbortController();
    const signal = AbortSignal.any([work.signal, abort.signal]);
    const request: Request = async (call, callSignal = signal) => {
      callSignal.throwIfAborted();
      try {
        const handle = await work.callHost({
          workload: OWNER_CAPABILITY_WORKLOAD,
          body: encodeCapability(call),
          signal: callSignal,
          // Action calls remain open through nested provider work and its
          // durable finalization; Oxian's short RPC default is insufficient.
          deadlineAtMs: Date.now() + deliveryTimeoutMs,
        });
        const response = await readCapability(handle.output) as {
          value?: unknown;
          error?: unknown;
        };
        await handle.completed;
        if (response.error !== undefined) throw response.error;
        return response.value;
      } catch (error) {
        if (isHostCallError(error)) {
          const failure = capabilityError(
            error.execution === "indeterminate"
              ? "owner_call_indeterminate"
              : `owner_${error.code}`,
            error.message,
          );
          Object.assign(failure, { execution: error.execution, cause: error });
          if (
            error.execution === "indeterminate" ||
            error.code === "deadline_exceeded"
          ) abort.abort(failure);
          throw failure;
        }
        throw error;
      }
    };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of work.input) {
      size += chunk.length;
      if (size > OWNER_CAPABILITY_BYTES / 2) {
        throw capabilityError("owner_data_limit");
      }
      chunks.push(chunk);
    }
    const input = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      input.set(chunk, offset);
      offset += chunk.length;
    }
    await request({ kind: "open", value: input });
    const factories = new Map<string, () => unknown>();
    const running = new Map<
      string,
      { abort: AbortController; task: Promise<void> }
    >();
    let failure: unknown;
    const invoke = async (
      invocation: CapabilityInvocation,
      localAbort: AbortController,
    ) => {
      const local = workerContext({
        invocation,
        registry: options.registry,
        request,
        signal: AbortSignal.any([signal, localAbort.signal]),
        factories,
      });
      try {
        const definition = invocation.kind === "processor" ||
            invocation.kind === "processorError"
          ? options.registry.processors[invocation.alias]
          : options.registry.actions[invocation.alias];
        const method = invocation.kind === "processor"
          ? "handle"
          : invocation.kind === "processorError"
          ? "onError"
          : invocation.kind === "action"
          ? "execute"
          : invocation.kind;
        const handler = invocation.kind === "prepare"
          ? factories.get(invocation.alias)
          : (definition as unknown as RecordValue)?.[method];
        if (typeof handler !== "function") {
          throw capabilityError("owner_definition_unavailable");
        }
        const value = await withContextCollectionInvocation(
          local.context,
          () =>
            invocation.kind === "prepare"
              ? (handler as () => unknown)()
              : (handler as Method)(...invocation.args, local.context),
        );
        await local.drain();
        await request({ kind: "complete", id: invocation.id, value });
      } catch (error) {
        await local.drain().catch(() => undefined);
        await request({
          kind: "complete",
          id: invocation.id,
          error: error instanceof Error ? error : new Error(String(error)),
        }).catch((error) => {
          failure ??= error;
          abort.abort(error);
        });
      } finally {
        local.stop();
        running.delete(invocation.id);
      }
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const poll = await request({ kind: "next" }) as CapabilityPoll;
        if (poll.aborted) {
          running.get(poll.aborted)?.abort.abort(
            capabilityError("owner_context_cancelled"),
          );
        }
        if (poll.invocation) {
          if (running.size >= MAX_ACTIVE_INVOCATIONS) {
            throw capabilityError("owner_capacity");
          }
          const invocation = poll.invocation;
          const controller = new AbortController();
          const task = Promise.resolve().then(() =>
            invoke(invocation, controller)
          );
          running.set(invocation.id, { abort: controller, task });
          void task.catch((error) => {
            failure ??= error;
            abort.abort(error);
          });
        }
        if (poll.done) {
          await Promise.all([...running.values()].map((entry) => entry.task));
          if (poll.error !== undefined) throw poll.error;
          if (failure) throw failure;
          return poll.result as Awaited<ReturnType<WorkerWorkHandler>>;
        }
      }
    } finally {
      abort.abort(capabilityError("owner_assignment_ended"));
      await Promise.allSettled(
        [...running.values()].map((entry) => entry.task),
      );
    }
  };
  return Object.fromEntries(
    (options.workloads ?? ["copilotz.delivery.v1"]).map((
      name,
    ) => [name, execute]),
  );
}

export async function recoverOwnerReceipt(
  worker: Pick<import("../../dependencies/oxian-worker.ts").Worker, "callHost">,
  receipt: NonNullable<CapabilityCall["receipt"]>,
): Promise<boolean> {
  const handle = await worker.callHost({
    workload: OWNER_CAPABILITY_WORKLOAD,
    body: encodeCapability({ kind: "receipt", value: receipt }),
    deadlineAtMs: Date.now() + 10_000,
  });
  const response = await readCapability(handle.output) as {
    value?: unknown;
    error?: unknown;
  };
  await handle.completed;
  return response.error === undefined && response.value === true;
}
