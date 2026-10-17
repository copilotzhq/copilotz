/** Storage host composition. This module must never enter a worker artifact. */
import { createOwnerHost } from "./owner-host.ts";
import {
  captureOwnerComposition,
  composeOwnerWorker,
  snapshotOwnerConfiguration,
  validateOwnerComposition,
} from "./owner-composition.ts";
import type {
  OwnerApplication,
  OwnerStorageOptions,
} from "./owner-composition-types.ts";

export async function createOwnerStorageApplication<
  const T extends OwnerStorageOptions,
>(
  options: T,
): Promise<OwnerApplication<T>> {
  if (!options?.storage || Object.hasOwn(options, "owner")) {
    throw new TypeError(
      "Storage composition requires storage and refuses owner connection options.",
    );
  }
  const captured = captureOwnerComposition(options);
  const storage = {
    ...options.storage,
    policy: { ...options.storage.policy },
    transport: snapshotOwnerConfiguration(options.storage.transport),
  };
  const ownerId = storage.ownerId;
  const registry = validateOwnerComposition(captured);
  const host = await createOwnerHost({ ...storage, registry }, [
    captured.namespace,
  ]);
  try {
    const worker = composeOwnerWorker(
      captured,
      ownerId,
      registry,
    );
    let closing: Promise<void> | undefined;
    const close = (reason?: string) =>
      closing ??= (async () => {
        // Start both cleanups: neither transport shutdown can depend on a peer
        // which we have not yet told to stop. The SQL session remains host-owned.
        const results = await Promise.allSettled([
          Promise.resolve().then(() => worker.close(reason)),
          Promise.resolve().then(() => host.close(reason)),
        ]);
        const failures = results.filter((
          result,
        ): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) {
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Owner application close failed.",
          );
        }
      })();
    const hostRetired = host.stopped.then(() => {
      throw new Error("Owner host authority stopped.");
    });
    const ready = Promise.race([
      worker.ready.then(() => {
        if (!host.snapshot().ready) throw new Error("Owner host is not ready.");
      }),
      hostRetired,
    ]).catch(async (error) => {
      await close("owner_application_initialization_failed").catch(() =>
        undefined
      );
      throw error;
    });
    void ready.catch(() => undefined);
    const closed = Promise.race([worker.closed, host.stopped]).then(
      () => close("owner_application_stopped"),
      async (error) => {
        await close("owner_application_failed").catch(() => undefined);
        throw error;
      },
    );
    void closed.catch(() => undefined);
    return { actions: worker.actions, ready, closed, close };
  } catch (error) {
    await host.close("owner_application_initialization_failed").catch(() =>
      undefined
    );
    throw error;
  }
}
