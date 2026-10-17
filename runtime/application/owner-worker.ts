/** Database-free connected execution composition. Owner authority remains on
 * named reverse calls; a transport Ready alone never admits application work. */
import {
  createWorker,
  type Worker,
  type WorkerOptions,
} from "../../dependencies/oxian-worker.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createRegisteredActionWorker,
  type RegisteredWorkerOptions,
} from "../execution/registered-worker.ts";
import { createRegisteredOwnerExecutionPort } from "../execution/owner-port.ts";
import {
  createOwnerConnection,
  type OwnerHostCaller,
} from "../owner/connection.ts";

export const OWNER_ACTION_WORKLOAD = "copilotz.action.execute";
export type OwnerConnectedWorkerOptions = Readonly<{
  registry: PluginRegistry;
  ownerId: string;
  namespace: string;
  worker: Omit<WorkerOptions, "workloads">;
  createCapabilities: RegisteredWorkerOptions["createCapabilities"];
  ownerReadyTimeoutMs?: number;
}>;
type HostWorker = Worker & { callHost?: OwnerHostCaller };
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function unavailable(): Error {
  return new Error("Owner execution session is not ready.");
}
/** Each workload gets a permanently parent-bound port. The registry is shared,
 * but no caller/assignment/claim authority is shared across concurrent work. */
export function createOwnerConnectedWorker(
  options: OwnerConnectedWorkerOptions,
  factory: typeof createWorker = createWorker,
) {
  const { registry, ownerId, namespace, createCapabilities } = options;
  if (
    ![ownerId, namespace].every((value) =>
      typeof value === "string" && value.trim()
    )
  ) throw new TypeError("Owner coordinates must be nonempty.");
  const timeout = options.ownerReadyTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new TypeError("Owner readiness timeout is invalid.");
  }
  const first = deferred();
  type Session = {
    id: string;
    signal: AbortSignal;
    gate: ReturnType<typeof deferred>;
    ready: boolean;
  };
  let current: Session | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (reason?: string) => stopping ??= worker.stop(reason);
  const closeSession = (session: Session, reason: unknown) => {
    session.ready = false;
    session.gate.reject(reason);
    if (current === session) current = undefined;
  };
  const worker = factory({
    ...options.worker,
    workloads: {
      [OWNER_ACTION_WORKLOAD]: async (context) => {
        const session = current;
        if (!session) throw unavailable();
        const cancelled = deferred();
        const abort = () =>
          cancelled.reject(context.signal.reason ?? unavailable());
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) abort();
        try {
          await Promise.race([session.gate.promise, cancelled.promise]);
          if (
            current !== session || !session.ready || session.signal.aborted ||
            context.signal.aborted
          ) throw unavailable();
          const callHost =
            (context as unknown as { callHost?: OwnerHostCaller }).callHost;
          if (typeof callHost !== "function") {
            throw new Error("Oxian worker-originated calls are required.");
          }
          // Work body cannot provide Action inputs; only the owner projection can.
          await context.input.cancel();
          const connection = createOwnerConnection({ ownerId, callHost });
          const execution = createRegisteredActionWorker({
            registry,
            owner: createRegisteredOwnerExecutionPort({
              ownerId,
              namespace,
              port: connection,
            }),
            createCapabilities,
            maxAssignments: 1,
          });
          const result = await execution.execute({
            assignmentId: context.streamId,
            sessionId: session.id,
          }, { signal: context.signal });
          return new TextEncoder().encode(
            JSON.stringify({ status: result.status, receipt: result.receipt }),
          );
        } finally {
          context.signal.removeEventListener("abort", abort);
        }
      },
    },
  }, {
    onReady(context) {
      const id = context.snapshot.connectionId;
      if (!id) {
        first.reject(unavailable());
        return;
      }
      const session: Session = {
        id,
        signal: context.signal,
        gate: deferred(),
        ready: false,
      };
      if (current) closeSession(current, unavailable());
      current = session;
      const abort = () =>
        closeSession(session, context.signal.reason ?? unavailable());
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) abort();
      // Oxian's receive loop starts after this callback returns. Never await a
      // reverse response here; the off-loop probe gates workload execution.
      queueMicrotask(() => {
        void (async () => {
          if (typeof worker.callHost !== "function") {
            throw new Error("Oxian worker-originated calls are required.");
          }
          await createOwnerConnection({ ownerId, callHost: worker.callHost })
            .ready({
              signal: context.signal,
              deadlineAtMs: Date.now() + timeout,
            });
          if (
            current !== session || context.signal.aborted ||
            worker.snapshot().connectionId !== id
          ) throw unavailable();
          session.ready = true;
          session.gate.resolve();
          first.resolve();
        })().catch((error) => {
          // An old session cannot reject a replacement's readiness or stop it.
          if (current !== session) return;
          closeSession(session, error);
          first.reject(error);
          void stop("owner_readiness_failed").catch(() => undefined);
        });
      });
    },
  }) as HostWorker;
  void worker.ready.catch((error) => first.reject(error));
  void worker.closed.then(() => {
    if (current) closeSession(current, unavailable());
    first.reject(unavailable());
  }, (error) => {
    if (current) closeSession(current, error);
    first.reject(error);
  });
  const ready = first.promise.catch(async (error) => {
    await stop("owner_readiness_failed").catch(() => undefined);
    throw error;
  });
  void ready.catch(() => undefined);
  return {
    ready,
    closed: worker.closed,
    close: stop,
    snapshot: () => ({
      transport: worker.snapshot(),
      ownerReady: current?.ready === true,
    }),
  };
}
