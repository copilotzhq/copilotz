import { DELIVERY_DEADLINE_MS } from "../execution/deadlines.ts";
import type { WorkHandle } from "../../dependencies/oxian-work.ts";
import {
  createHypervisor,
  type Hypervisor,
  type HypervisorOptions,
  type WorkerCallContext,
} from "../../dependencies/oxian-hypervisor.ts";
import {
  createWorker,
  type Worker,
  type WorkerOptions,
} from "../../dependencies/oxian-worker.ts";
import type { OwnerSessionSource } from "../execution/types.ts";
import type {
  CopilotzShard,
  ShardOwnerBinding,
  ShardWorkInput,
} from "./shard.ts";
import { createShardController } from "./shard-controller.ts";

import { shardSessionKind } from "./shard-identity.ts";

const RELAY = "copilotz.shard.relay.v1";
type Session = ReturnType<Hypervisor["sessions"]["assertCurrent"]>;
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const same = (
  a: Parameters<Hypervisor["sessions"]["assertCurrent"]>[0],
  b: Parameters<Hypervisor["sessions"]["assertCurrent"]>[0],
) =>
  a.connectionId === b.connectionId &&
  a.sessionGeneration === b.sessionGeneration &&
  a.identity.workerId === b.identity.workerId &&
  a.identity.attemptId === b.identity.attemptId &&
  a.identity.epoch === b.identity.epoch;

/** Owner-side accepted-session authority. Only the authenticated shard uplink writes it. */
export type ShardDispatcher = Readonly<
  {
    hypervisor: Hypervisor;
    sessions: OwnerSessionSource;
    dispatch(input: ShardWorkInput): Promise<WorkHandle>;
    close(reason?: string): Promise<void>;
  }
>;
export type ShardDispatcherConnection = Readonly<
  { ready: Worker["ready"]; close(reason?: string): Promise<void> }
>;
export function createShardDispatcher(options: {
  shardId: string;
  controller: Parameters<typeof createShardController>[0];
  transports: HypervisorOptions["transports"];
  admit: NonNullable<HypervisorOptions["admit"]>;
  binding: ShardOwnerBinding;
}): ShardDispatcher {
  const current = new Map<string, Session>();
  const subscribers = new Set<(session: Session) => void>();
  const publish = (session: Session) => {
    if (shardSessionKind(session.identity.workerId) !== "worker") return;
    const previous = current.get(session.identity.workerId);
    if (
      previous &&
      (previous.identity.epoch > session.identity.epoch ||
        (previous.identity.epoch === session.identity.epoch &&
          previous.sessionGeneration > session.sessionGeneration))
    ) return;
    if (["closed", "expired", "drained"].includes(session.phase)) {
      if (previous && !same(previous, session)) return;
      current.delete(session.identity.workerId);
    } else {current.set(
        session.identity.workerId,
        Object.freeze(structuredClone(session)),
      );}
    for (const subscriber of subscribers) subscriber(session);
  };
  const sessions: OwnerSessionSource = {
    list: () => [...current.values()],
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    assertCurrent(fence) {
      const session = current.get(fence.identity.workerId);
      if (
        !session || !same(session, fence) ||
        (session.transportType === "websocket" &&
          session.leaseExpiresAtMs <= Date.now()) ||
        !["ready", "draining", "connected"].includes(session.phase)
      ) throw new Error("Stale shard session");
      return session;
    },
  };
  let connectionId: string | undefined;
  const clear = () => {
    const retired = [...current.values()];
    const cleanup = retired.map((session) =>
      options.binding.lifecycle.onDisconnect?.({
        stage: "disconnect",
        stageId: crypto.randomUUID(),
        callbackAttempt: 1,
        signal: AbortSignal.abort(new Error("Shard relay disconnected")),
        fence: session,
        definition: {
          workerId: session.identity.workerId,
          providerId: "shard-relay",
          workloads: session.workloads,
          capacity: session.capacity,
          providerConfig: {},
          labels: {},
        },
        phase: session.phase === "closed" ? "expired" : session.phase,
        reason: "peer_closed",
        disconnectedAtMs: Date.now(),
      })
    );
    for (const session of retired) publish({ ...session, phase: "closed" });
    current.clear();
    return Promise.all(cleanup).then(() => undefined);
  };
  const hypervisor = createHypervisor({
    transports: options.transports,
    async admit(context) {
      const admitted = await options.admit(context);
      if (
        context.identity.workerId !== options.shardId ||
        admitted.definition.workerId !== options.shardId ||
        context.workloads.some((name) => name !== RELAY)
      ) throw new Error("Wrong shard relay identity");
      return admitted;
    },
    workerCalls: {
      admit: () => undefined,
      maxConcurrent: 1024,
      maxPerConnection: 128,
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
      // Host calls carry whole deliveries (nested LLM calls); Oxian uses the
      // lower of both sides' limits, so match the worker's delivery deadline.
      timeoutMs: DELIVERY_DEADLINE_MS,
      admitUnassigned(binding) {
        if (
          binding.workload !== RELAY ||
          binding.fence.connectionId !== connectionId
        ) return;
        return async (call) => {
          const metadata = binding.metadata;
          if (metadata.kind === "session") {
            const session = await new Response(call.input).json() as Session;
            call.signal.throwIfAborted();
            if (binding.fence.connectionId !== connectionId) {
              throw new Error("Replaced shard relay");
            }
            publish(session);
            return;
          }
          if (metadata.kind === "lifecycle") {
            const event = await new Response(call.input).json();
            const name = metadata.name;
            if (name === "onDisconnect") {
              await options.binding.lifecycle.onDisconnect?.(event);
            } else if (name === "onComplete") {
              await options.binding.lifecycle.onComplete?.(event);
            } else if (name === "onReady") {
              await options.binding.lifecycle.onReady?.({
                ...event,
                signal: call.signal,
              });
            } else throw new Error("Invalid shard lifecycle");
            return;
          }
          if (metadata.kind !== "call") {
            throw new Error("Invalid shard relay call");
          }
          const forwarded = metadata.binding as unknown as Omit<
            WorkerCallContext,
            "signal"
          >;
          sessions.assertCurrent(forwarded.fence);
          const context = { ...forwarded, signal: call.signal };
          const handler = context.parent
            ? await options.binding.workerCalls.admit(context)
            : await options.binding.workerCalls.admitUnassigned?.(context);
          if (!handler) throw new Error("Owner capability refused");
          sessions.assertCurrent(forwarded.fence);
          return await handler(call);
        };
      },
    },
  }, {
    async onReady(event) {
      await clear();
      connectionId = event.fence.connectionId;
    },
    onDisconnect(event) {
      if (connectionId === event.fence.connectionId) {
        connectionId = undefined;
        return clear();
      }
    },
  });
  const controller = createShardController(options.controller);
  return {
    hypervisor,
    sessions,
    dispatch: controller.dispatch,
    async close(reason?: string) {
      await clear();
      await hypervisor.shutdown(reason);
    },
  };
}

/** Shard-side relay. Session updates are ordered before owner capability calls. */
export function connectShardDispatcher(options: {
  shard: CopilotzShard;
  worker: Omit<WorkerOptions, "workloads">;
}): ShardDispatcherConnection {
  let sequence = Promise.resolve();
  let closed = false;
  const worker = createWorker({
    ...options.worker,
    workloads: { [RELAY]: () => undefined },
  }, {
    async onReady() {
      // A fresh owner connection starts with no accepted leaf sessions.
      for (const session of options.shard.hypervisor.sessions.list()) {
        await sendSession(session);
      }
    },
  });
  async function control(metadata: Record<string, string>, value: unknown) {
    const handle = await worker.callHost({
      workload: RELAY,
      metadata,
      body: encode(value),
    });
    await new Response(handle.output).arrayBuffer();
    await handle.completed;
  }
  function sendSession(session: Session) {
    if (shardSessionKind(session.identity.workerId) !== "worker") {
      return Promise.resolve();
    }
    return control({ kind: "session" }, session);
  }
  const enqueue = (run: () => Promise<void>) => {
    sequence = sequence.catch(() => undefined).then(run);
    void sequence.catch(() => undefined);
    return sequence;
  };
  const unsubscribe = options.shard.hypervisor.sessions.subscribe!(
    (session) => {
      if (!closed && worker.snapshot().state === "ready") {
        void enqueue(() => sendSession(session));
      }
    },
  );
  const admit: ShardOwnerBinding["workerCalls"]["admit"] =
    (binding) => async (call) => {
      await worker.ready;
      await sequence;
      options.shard.hypervisor.sessions.assertCurrent(binding.fence);
      const { signal: _signal, ...forwarded } = binding;
      const handle = await worker.callHost({
        workload: RELAY,
        metadata: {
          kind: "call",
          binding: forwarded as unknown as NonNullable<
            Parameters<typeof worker.callHost>[0]["metadata"]
          >,
        },
        body: call.input,
        signal: binding.signal,
      });
      await handle.started;
      return { metadata: await handle.metadata, body: handle.output };
    };
  const lifecycle = (name: string, event: unknown) =>
    enqueue(async () => {
      await worker.ready;
      await control({ kind: "lifecycle", name }, event);
    });
  options.shard.bindOwner({
    workerCalls: { admit, admitUnassigned: admit },
    lifecycle: {
      onReady(event) {
        const { signal: _signal, ...wire } = event;
        return lifecycle("onReady", wire);
      },
      onDisconnect: (event) => lifecycle("onDisconnect", event),
      onComplete(event) {
        const { signal: _signal, ...wire } = event;
        return lifecycle("onComplete", wire);
      },
    },
  });
  return {
    ready: worker.ready,
    async close(reason?: string) {
      closed = true;
      unsubscribe();
      await worker.stop(reason);
    },
  };
}
