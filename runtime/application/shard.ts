import {
  createHypervisor,
  type Hypervisor,
  type HypervisorLifecycleCallbacks,
  type HypervisorOptions,
  type WorkerCallContext,
} from "../../dependencies/oxian-hypervisor.ts";
import type { WorkHandle, WorkInput } from "../../dependencies/oxian-work.ts";
import { withOwnedHosting } from "./hosting.ts";
import { shardSessionId, shardSessionKind } from "./shard-identity.ts";

type AdmissionContext = Parameters<NonNullable<HypervisorOptions["admit"]>>[0];
type Admission = Awaited<ReturnType<NonNullable<HypervisorOptions["admit"]>>>;
export type ShardWorkerKind = "worker" | "computer" | "browser" | "connector";
export type ShardActor = Readonly<{ namespace: string; id: string }>;
export type ShardPrincipal = Readonly<{
  kind: ShardWorkerKind;
  /** Authoritative workload scope, independent of the worker's hello. */
  workloads: readonly string[];
  /** Separately admitted callHost routes; never grants the owner protocol. */
  calls?: readonly string[];
  actor?: ShardActor;
}>;
export type ShardOwnerBinding = Readonly<{
  workerCalls: NonNullable<HypervisorOptions["workerCalls"]>;
  lifecycle: NonNullable<HypervisorLifecycleCallbacks>;
}>;
export type ShardWorkInput =
  & WorkInput
  & Readonly<{
    kind?: ShardWorkerKind;
    epoch?: number;
    attemptId?: string;
    /** Trusted controller actor, checked against authenticated browser admission. */
    actor?: ShardActor;
    requireConnected?: boolean;
  }>;
export type CreateCopilotzShardOptions = Readonly<{
  id: string;
  shardIds?: readonly string[];
  transports: HypervisorOptions["transports"];
  admit(context: AdmissionContext):
    | (Admission & { principal: ShardPrincipal })
    | Promise<Admission & { principal: ShardPrincipal }>;
  calls?: NonNullable<HypervisorOptions["workerCalls"]>;
  capacity?: number;
  scaleAt?: number;
  config?: HypervisorOptions["config"];
  fallback?: HypervisorOptions["fallback"];
  signal?: AbortSignal;
}>;
export type CopilotzShard = Readonly<{
  role: "shard";
  id: string;
  /** Adapter authority for previews, duplex relays and native listeners. */
  hypervisor: Hypervisor;
  dispatch(input: ShardWorkInput): Promise<WorkHandle>;
  bindOwner(binding: ShardOwnerBinding): Readonly<{
    dispatch(input: WorkInput): Promise<WorkHandle>;
    sessions: Hypervisor["sessions"];
  }>;
  capacity(): Readonly<{
    sessions: number;
    ready: number;
    capacity: number;
    reserved: number;
    queued: number;
    utilization: number;
    needsMoreShards: boolean;
    draining: boolean;
  }>;
  drain(reason?: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
  close(reason?: string): Promise<void>;
}>;

function refused(code: string): Error {
  return Object.assign(new Error(code), { code, started: false });
}
function actorKey(actor: ShardActor): string {
  if (!actor?.namespace?.trim() || !actor?.id?.trim()) {
    throw new TypeError(
      "A browser requires an authenticated namespace and actor.",
    );
  }
  return JSON.stringify([actor.namespace, actor.id]);
}
/** Rendezvous placement: stable across order changes, minimal movement on resize. */
export async function shardForActor(
  actor: ShardActor,
  shardIds: readonly string[],
): Promise<string> {
  const key = actorKey(actor);
  const ids = [...new Set(shardIds)].sort();
  if (!ids.length || ids.some((id) => !id.trim())) {
    throw new TypeError("Shard IDs must be nonempty.");
  }
  const scores = await Promise.all(ids.map(async (id) => {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([key, id])),
      ),
    );
    return {
      id,
      score: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
        "",
      ),
    };
  }));
  scores.sort((a, b) =>
    b.score.localeCompare(a.score) || a.id.localeCompare(b.id)
  );
  return scores[0].id;
}

/** A pinned socket host. Persistence and effects remain at the bound owner. */
export function createCopilotzShard(
  options: CreateCopilotzShardOptions,
): CopilotzShard {
  if (
    ["database", "persistence", "databaseScopes"].some((key) =>
      Object.hasOwn(options, key)
    )
  ) {
    throw new TypeError("Shards accept owner capabilities, never a database.");
  }
  const id = options.id;
  const ids = [...(options.shardIds ?? [id])];
  const limit = options.capacity ?? 500;
  const scaleAt = options.scaleAt ?? 0.7;
  if (
    !id?.trim() || !ids.includes(id) || !Number.isSafeInteger(limit) ||
    limit < 1 || !(scaleAt > 0 && scaleAt <= 1)
  ) {
    throw new TypeError("Invalid shard identity or capacity.");
  }
  const principals = new Map<string, ShardPrincipal>();
  const intents = new Map<string, ShardWorkInput>();
  let owner: ShardOwnerBinding | undefined;
  let draining = false;
  let closed = false;
  const principalOf = (binding: WorkerCallContext) =>
    principals.get(binding.fence.connectionId);
  const admitCall = (
    assigned: boolean,
  ): NonNullable<HypervisorOptions["workerCalls"]>["admit"] =>
  (binding) => {
    const principal = principalOf(binding);
    if (!principal || closed) return;
    if (principal.kind === "worker") {
      return assigned
        ? owner?.workerCalls.admit(binding)
        : owner?.workerCalls.admitUnassigned?.(binding);
    }
    if (
      binding.workload.startsWith("copilotz.owner.") ||
      !principal.calls?.includes(binding.workload)
    ) return;
    return assigned
      ? options.calls?.admit(binding)
      : options.calls?.admitUnassigned?.(binding);
  };
  const check = (
    input: ShardWorkInput,
    session: ReturnType<Hypervisor["sessions"]["assertCurrent"]>,
  ) => {
    const principal = principals.get(session.connectionId);
    if (!principal || principal.kind !== (input.kind ?? "worker")) return false;
    if (!principal.workloads.includes(input.workload)) return false;
    if (input.epoch !== undefined && session.identity.epoch !== input.epoch) {
      return false;
    }
    if (
      input.attemptId !== undefined &&
      session.identity.attemptId !== input.attemptId
    ) return false;
    if (
      principal.kind === "browser" &&
      (!input.actor || !principal.actor ||
        actorKey(input.actor) !== actorKey(principal.actor))
    ) return false;
    return true;
  };
  const hypervisor = createHypervisor({
    transports: options.transports,
    signal: options.signal,
    config: { maxQueuedDispatches: 1024, ...options.config },
    fallback: options.fallback,
    async admit(context) {
      const admitted = await options.admit(context);
      const principal = structuredClone(admitted.principal);
      if (
        !["worker", "computer", "browser", "connector"].includes(
          principal?.kind,
        ) || !Array.isArray(principal.workloads) || !principal.workloads.length
      ) throw refused("invalid_principal");
      if (shardSessionKind(context.identity.workerId) !== principal.kind) {
        throw refused("principal_kind_mismatch");
      }
      if (
        principal.kind === "browser" &&
        (!principal.actor || await shardForActor(principal.actor, ids) !== id)
      ) throw refused("wrong_actor_shard");
      if (
        context.workloads.some((name) => !principal.workloads.includes(name))
      ) throw refused("workload_scope_refused");
      return {
        ...admitted,
        definition: {
          ...admitted.definition,
          workloads: context.workloads.filter((name) =>
            principal.workloads.includes(name)
          ),
          labels: {
            ...admitted.definition.labels,
            copilotzShardPrincipal: principal as unknown as NonNullable<
              WorkInput["metadata"]
            >,
          },
        },
      };
    },
    assign(context) {
      const token = context.metadata.copilotzShardIntent;
      const intent = typeof token === "string" ? intents.get(token) : undefined;
      if (!intent || draining || closed) {
        throw refused("shard_dispatch_refused");
      }
      const target = intent.target &&
        hypervisor.sessions.get(intent.target.workerId);
      if (
        target && intent.epoch !== undefined &&
        target.identity.epoch > intent.epoch
      ) throw refused("stale_epoch");
      const selected = context.available.find((fence) =>
        check(intent, hypervisor.sessions.assertCurrent(fence))
      );
      // Oxian treats undefined as default placement, never as an authorization refusal.
      if (!selected) throw refused("worker_scope_refused");
      return selected;
    },
    workerCalls: {
      ...options.calls,
      admit: admitCall(true),
      admitUnassigned: admitCall(false),
      maxConcurrent: 1024,
      maxPerConnection: 128,
    },
  }, {
    onHandshake(event) {
      const principal = event.definition.labels
        .copilotzShardPrincipal as unknown as ShardPrincipal;
      if (!principal) throw refused("missing_principal");
      principals.set(event.fence.connectionId, principal);
    },
    async onReady(event) {
      if (principals.get(event.fence.connectionId)?.kind === "worker") {
        await owner?.lifecycle.onReady?.(event);
      }
    },
    async onDisconnect(event) {
      if (principals.get(event.fence.connectionId)?.kind === "worker") {
        await owner?.lifecycle.onDisconnect?.(event);
      }
      principals.delete(event.fence.connectionId);
    },
    async onComplete(event) {
      if (principals.get(event.fence.connectionId)?.kind === "worker") {
        await owner?.lifecycle.onComplete?.(event);
      }
    },
  });
  const dispatch = async (input: ShardWorkInput): Promise<WorkHandle> => {
    input = {
      ...input,
      ...(input.target
        ? {
          target: {
            workerId: shardSessionId(
              input.kind ?? "worker",
              input.target.workerId,
            ),
          },
        }
        : {}),
    };
    if (draining || closed) throw refused("shard_draining");
    if (
      input.epoch !== undefined &&
      (!Number.isSafeInteger(input.epoch) || input.epoch < 1)
    ) throw refused("invalid_epoch");
    if (
      input.kind === "browser" &&
      (!input.actor || await shardForActor(input.actor, ids) !== id)
    ) throw refused("wrong_actor_shard");
    const current = input.target &&
      hypervisor.sessions.get(input.target.workerId);
    if (
      current && input.epoch !== undefined &&
      current.identity.epoch > input.epoch
    ) throw refused("stale_epoch");
    if (
      input.requireConnected &&
      (!current || current.phase !== "ready" || !check(input, current))
    ) throw refused("worker_offline");
    if (
      current && input.epoch !== undefined &&
      current.identity.epoch < input.epoch
    ) {
      // Exact-session termination cannot kill a concurrent replacement.
      await hypervisor.shutdownSession(current, "superseded");
    }
    const token = crypto.randomUUID();
    intents.set(token, {
      ...input,
      actor: input.actor && { ...input.actor },
      target: input.target && { ...input.target },
    });
    try {
      const handle = await hypervisor.dispatch({
        ...input,
        metadata: { ...input.metadata, copilotzShardIntent: token },
      });
      void handle.started.finally(() => intents.delete(token)).catch(() =>
        undefined
      );
      return handle;
    } catch (error) {
      intents.delete(token);
      throw error;
    }
  };
  let drainTask: Promise<void> | undefined;
  const drain = (reason = "shard_draining") => {
    draining = true;
    return drainTask ??= Promise.all(
      hypervisor.sessions.list().map((session) =>
        hypervisor.drain(session.identity.workerId, reason)
      ),
    ).then(() => undefined);
  };
  const hosted: Hypervisor = {
    ...hypervisor,
    // Refuse the upgrade, not the credential: draining peers must reconnect.
    prepare(request) {
      return draining || closed
        ? {
          kind: "response",
          response: new Response(null, {
            status: 503,
            headers: { "retry-after": "1" },
          }),
        }
        : hypervisor.prepare(request);
    },
  };
  return withOwnedHosting({
    role: "shard" as const,
    id,
    hypervisor: hosted,
    dispatch,
    bindOwner(binding: ShardOwnerBinding) {
      if (closed || draining) throw refused("shard_draining");
      owner = binding;
      return {
        dispatch: (input: WorkInput) => dispatch({ ...input, kind: "worker" }),
        sessions: {
          ...hypervisor.sessions,
          list: () =>
            hypervisor.sessions.list().filter((session) =>
              shardSessionKind(session.identity.workerId) === "worker"
            ),
          get: (workerId) =>
            shardSessionKind(workerId) === "worker"
              ? hypervisor.sessions.get(workerId)
              : undefined,
          subscribe: (listener) =>
            hypervisor.sessions.subscribe!((session) => {
              if (
                shardSessionKind(session.identity.workerId) === "worker"
              ) listener(session);
            }),
          assertCurrent(fence) {
            if (shardSessionKind(fence.identity.workerId) !== "worker") {
              throw refused("worker_scope_refused");
            }
            return hypervisor.sessions.assertCurrent(fence);
          },
        },
      };
    },
    capacity() {
      const sessions = hypervisor.sessions.list().filter((session) =>
        !["closed", "expired", "drained"].includes(session.phase)
      );
      const ready = sessions.filter((session) => session.phase === "ready");
      const capacity = ready.reduce((n, session) => n + session.capacity, 0);
      const reserved = ready.reduce((n, session) => n + session.reserved, 0);
      const queued = hypervisor.snapshot().queuedDispatches;
      const utilization = Math.max(
        sessions.length / limit,
        capacity ? reserved / capacity : 0,
      );
      return {
        sessions: sessions.length,
        ready: ready.length,
        capacity,
        reserved,
        queued,
        utilization,
        needsMoreShards: queued > 0 || utilization >= scaleAt,
        draining,
      };
    },
    drain,
    fetch: async (request: Request) =>
      await options.fallback?.(request) ?? new Response(null, { status: 404 }),
    async close(reason?: string) {
      closed = true;
      draining = true;
      await hypervisor.shutdown(reason);
      principals.clear();
      intents.clear();
    },
  }, hosted);
}
