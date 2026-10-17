/** Common database-free worker composition used by both owner-backed placements. */
import type { Worker } from "../../dependencies/oxian-worker.ts";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "../plugins/registry.ts";
import { actionDefinitionHasSecrets } from "../actions/secret.ts";
import {
  createOwnerConnection,
  type OwnerHostCaller,
} from "../owner/connection.ts";
import { createOwnerConnectedWorker } from "./owner-worker.ts";
import { createOwnerActionCallers } from "./owner-actions.ts";
import type {
  OwnerApplication,
  OwnerApplicationActionOptions,
  OwnerComposition,
  OwnerConnectionOptions,
} from "./owner-composition-types.ts";

function unavailable(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError("Owner composition identifiers must be nonempty text.");
  }
}
/** Snapshot routing containers while retaining deliberately injected callbacks,
 * cancellation signals and opaque host handles. No executable plugin cloning. */
export function snapshotOwnerConfiguration<T>(value: T): T {
  if (value instanceof URL) return new URL(value.href) as T;
  if (Array.isArray(value)) return value.map(snapshotOwnerConfiguration) as T;
  if (
    value && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, entry],
      ) => [key, snapshotOwnerConfiguration(entry)]),
    ) as T;
  }
  return value;
}
export function captureOwnerComposition<T extends OwnerComposition>(
  options: T,
): T {
  return {
    ...options,
    worker: {
      connection: snapshotOwnerConfiguration(options.worker?.connection),
      createWorker: options.worker?.createWorker,
    },
    ...(options.actionWait ? { actionWait: { ...options.actionWait } } : {}),
  };
}
/** Called before transport or SQL startup. Never silently falls back to legacy. */
export function validateOwnerComposition(
  options: OwnerComposition,
): PluginRegistry {
  identifier(options.namespace);
  for (
    const legacy of [
      "role",
      "database",
      "databaseSchema",
      "persistence",
      "engine",
      "dispatcher",
    ]
  ) {
    if (Object.hasOwn(options, legacy)) {
      throw new TypeError(
        `Owner composition cannot mix legacy option '${legacy}'.`,
      );
    }
  }
  if (
    !options.worker || typeof options.worker.createWorker !== "function" ||
    !options.worker.connection
  ) {
    throw new TypeError(
      "An explicit compatible owner worker connection and factory are required.",
    );
  }
  if (Object.hasOwn(options.worker.connection, "workloads")) {
    throw new TypeError(
      "Owner composition owns the whole-plugin worker workloads.",
    );
  }
  const known = new Set([
    "namespace",
    "plugins",
    "actions",
    "collections",
    "processors",
    "resources",
    "adapters",
    "views",
    "worker",
    "actionWait",
    "ownerReadyTimeoutMs",
    "childWaitMs",
    "owner",
    "storage",
  ]);
  if (Object.keys(options).some((key) => !known.has(key))) {
    throw new TypeError("Unsupported owner composition option.");
  }
  for (
    const [key, max] of [["maxPending", 10_000], ["maxWaitMs", 120_000], [
      "pollMs",
      10_000,
    ]] as const
  ) {
    const value = options.actionWait?.[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > max)
    ) {
      throw new TypeError("Invalid Action wait capacity.");
    }
  }
  if (
    options.actionWait &&
    Object.keys(options.actionWait).some((key) =>
      !["maxPending", "maxWaitMs", "pollMs"].includes(key)
    )
  ) {
    throw new TypeError("Unsupported Action wait option.");
  }
  for (
    const [key, max] of [["ownerReadyTimeoutMs", 120_000], [
      "childWaitMs",
      60_000,
    ]] as const
  ) {
    const value = options[key];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > max)
    ) {
      throw new TypeError(`Invalid owner composition ${key}.`);
    }
  }
  const registry = createPluginRegistry(options);
  for (const action of Object.values(registry.actions)) {
    if (
      action.content || action.resolve || actionDefinitionHasSecrets(action)
    ) {
      throw new TypeError(
        "Owner composition supports ordinary JSON Actions only.",
      );
    }
  }
  for (const collection of Object.values(registry.collections)) {
    if (collection.content?.fields.length) {
      throw new TypeError(
        "Owner composition content Collections are not implemented.",
      );
    }
  }
  return registry;
}
/** Internal shared constructor. No SQL/local shortcut for embedded placement. */
export function composeOwnerWorker<T extends OwnerComposition>(
  options: T,
  ownerId: string,
  registry: PluginRegistry,
): OwnerApplication<T> {
  identifier(ownerId);
  const namespace = options.namespace;
  let raw: (Worker & { callHost?: OwnerHostCaller }) | undefined;
  let sessionSignal: AbortSignal | undefined;
  let sessionLifetime: AbortController | undefined;
  const capabilities = (
    { projection }: { projection: { namespace: string; ownerId: string } },
  ) => {
    if (projection.namespace !== namespace || projection.ownerId !== ownerId) {
      unavailable("owner_assignment_scope_mismatch");
    }
    return { resources: registry.resources, adapters: registry.adapters };
  };
  const worker = createOwnerConnectedWorker({
    registry,
    ownerId,
    namespace,
    worker: options.worker.connection,
    createCapabilities: capabilities,
    createProcessorCapabilities: capabilities,
    ownerReadyTimeoutMs: options.ownerReadyTimeoutMs,
    childWaitMs: options.childWaitMs,
  }, (connection, lifecycle) => {
    raw = options.worker.createWorker(connection, {
      ...lifecycle,
      onReady(context) {
        sessionLifetime?.abort(new Error("Owner session replaced."));
        sessionLifetime = new AbortController();
        sessionSignal = AbortSignal.any([
          context.signal,
          sessionLifetime.signal,
        ]);
        return lifecycle?.onReady?.(context);
      },
    });
    return raw;
  });
  const connection = createOwnerConnection({
    ownerId,
    callHost(input) {
      if (
        !worker.snapshot().ownerReady || !raw?.callHost ||
        sessionSignal?.aborted
      ) {
        unavailable("owner_session_unavailable");
      }
      return raw.callHost(input);
    },
  });
  const facade = createOwnerActionCallers({
    actions: registry.actions,
    namespace,
    port: connection,
    ...options.actionWait,
  });
  const actions: Record<string, unknown> = Object.create(null);
  for (const [alias, call] of Object.entries(facade.actions)) {
    if (alias === "serverInvoke") continue;
    actions[alias] = async (
      input: unknown,
      callOptions: OwnerApplicationActionOptions = {},
    ) => {
      // Fail before admission: these fields are not authorities a worker can set.
      if (
        !callOptions || typeof callOptions !== "object" ||
        Object.keys(callOptions).some((key) =>
          !["idempotencyKey", "namespace", "signal"].includes(key)
        )
      ) {
        return Promise.reject(
          new TypeError("Unsupported owner Action call options."),
        );
      }
      if (
        callOptions.idempotencyKey !== undefined &&
        (typeof callOptions.idempotencyKey !== "string" ||
          !callOptions.idempotencyKey.trim())
      ) {
        throw new TypeError("Idempotency key must be non-empty.");
      }
      if (
        callOptions.namespace !== undefined &&
        callOptions.namespace !== namespace
      ) {
        return Promise.reject(
          new TypeError(
            "Owner Action namespace differs from construction namespace.",
          ),
        );
      }
      if (
        !worker.snapshot().ownerReady || !sessionSignal || sessionSignal.aborted
      ) {
        return Promise.reject(
          Object.assign(new Error("owner_session_unavailable"), {
            code: "owner_session_unavailable",
          }),
        );
      }
      const signal = AbortSignal.any([
        sessionSignal,
        ...(callOptions.signal ? [callOptions.signal] : []),
      ]);
      return await call(input, {
        operationKey: callOptions.idempotencyKey,
        signal,
      });
    };
  }
  let stopping: Promise<void> | undefined;
  const close = (reason?: string) => {
    facade.close();
    return stopping ??= Promise.resolve().then(() => worker.close(reason));
  };
  const closed = worker.closed.then(() => undefined).finally(() =>
    facade.close()
  );
  void closed.catch(() => undefined);
  return {
    actions: actions as OwnerApplication<T>["actions"],
    ready: worker.ready,
    closed,
    close,
  };
}
/** Database-free implementation used by the root and deliberate worker entry. */
export async function createOwnerConnectedApplication<
  const T extends OwnerConnectionOptions,
>(
  options: T,
): Promise<OwnerApplication<T>> {
  if (!options || !options.owner || Object.hasOwn(options, "storage")) {
    throw new TypeError(
      "Worker entry requires owner connection and refuses storage.",
    );
  }
  identifier(options.owner.id);
  const captured = captureOwnerComposition(options);
  const ownerId = options.owner.id;
  const registry = validateOwnerComposition(captured);
  return await Promise.resolve(composeOwnerWorker(captured, ownerId, registry));
}
