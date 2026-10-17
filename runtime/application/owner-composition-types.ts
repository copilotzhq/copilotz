/** Bounded owner-backed application composition. Storage stays on its host. */
import type {
  createWorker,
  WorkerOptions,
} from "../../dependencies/oxian-worker.ts";
import type { ActionInput, ActionMap, ActionOutput } from "../actions/types.ts";
import type {
  AnyCopilotzPlugin,
  CollectionMap,
  PluginAdapters,
  PluginResources,
  ProcessorMap,
} from "../plugins/types.ts";
import type { ViewMap } from "../views/definition.ts";
import type { RegistryComposition } from "../plugins/registry.ts";
import type { OwnerHostOptions } from "./owner-host.ts";

export type OwnerComposition = Readonly<{
  role?: never;
  database?: never;
  databaseSchema?: never;
  persistence?: never;
  engine?: never;
  dispatcher?: never;
  namespace: string;
  plugins?: readonly AnyCopilotzPlugin[];
  actions?: ActionMap;
  collections?: CollectionMap;
  processors?: ProcessorMap;
  resources?: PluginResources;
  adapters?: PluginAdapters;
  views?: ViewMap;
  /** A general leased execution worker, optionally admitted for root ingress by
   * the owner's independent current ingress policy. Never owner-local execution. */
  worker: Readonly<{
    connection: Omit<WorkerOptions, "workloads">;
    /** Required until the published Oxian dependency supplies reverse calls. */
    createWorker: typeof createWorker;
  }>;
  actionWait?: Readonly<
    { maxPending?: number; maxWaitMs?: number; pollMs?: number }
  >;
  ownerReadyTimeoutMs?: number;
  childWaitMs?: number;
}>;
/** Connect to an existing named owner. Connection/provisioning remains explicit. */
export type OwnerConnectionOptions =
  & OwnerComposition
  & Readonly<{
    owner: Readonly<{ id: string }>;
    storage?: never;
  }>;
/** Fresh, single-owner schema only. This starts an embedded leased worker;
 * restart/takeover and F5 owner-local/no-wall-clock execution are not supported.
 * The injected SQL session remains caller-owned, including on close/failure. */
export type OwnerStorageOptions =
  & OwnerComposition
  & Readonly<{
    storage: Omit<OwnerHostOptions, "registry">;
    owner?: never;
  }>;
type Option<T, K extends PropertyKey, Fallback> = K extends keyof T
  ? NonNullable<T[K]>
  : Fallback;
export type OwnerApplicationComposition<T extends OwnerComposition> =
  RegistryComposition<
    Option<T, "plugins", readonly []>,
    Option<T, "resources", Record<never, never>>,
    Option<T, "adapters", Record<never, never>>,
    Option<T, "actions", Record<never, never>>,
    Option<T, "collections", Record<never, never>>,
    Option<T, "processors", Record<never, never>>,
    Option<T, "views", Record<never, never>>
  >;
/** Public admission uses idempotencyKey; Action ctx calls retain operationKey.
 * signal interrupts this caller's wait, never durably cancels the Action. */
export type OwnerApplicationActionOptions = Readonly<{
  idempotencyKey?: string;
  namespace?: string;
  signal?: AbortSignal;
}>;
export type OwnerApplicationActions<A extends ActionMap> = Readonly<
  {
    [K in keyof A as K extends "serverInvoke" ? never : K]: (
      input: ActionInput<A[K]>,
      options?: OwnerApplicationActionOptions,
    ) => Promise<ActionOutput<A[K]>>;
  }
>;
/** Explicitly partial ordinary-Action application. No HTTP/read/observation or
 * full recovery surface is implied by readiness. Unsupported ctx capabilities
 * continue to refuse through the owner-backed execution implementation. */
export type OwnerApplication<T extends OwnerComposition = OwnerComposition> =
  Readonly<{
    actions: OwnerApplicationActions<OwnerApplicationComposition<T>["actions"]>;
    ready: Promise<void>;
    closed: Promise<void>;
    close(reason?: string): Promise<void>;
  }>;
