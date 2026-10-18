/** Placement-neutral read-only selection callback over a bound resource port. */
import type { OwnerSnapshotPort } from "../owner/connection.ts";
import type { OwnerJson } from "../owner/boundary.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { createCollectionReadCapability } from "./collection-read-capability.ts";
function uncertain(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as {
    code?: string;
    indeterminate?: boolean;
    outcome?: string;
  };
  return error.indeterminate === true || error.outcome === "unknown" ||
    [
      "owner_snapshot_cleanup_unknown",
      "owner_commit_unknown",
      "persistence_indeterminate",
      "effect_indeterminate",
    ].includes(error.code ?? "");
}
function combineFailure(errors: unknown[]): unknown {
  const error = new AggregateError(
    errors,
    "Snapshot callback or cleanup failed.",
    { cause: errors.at(-1) },
  );
  if (errors.some(uncertain)) {
    Object.assign(error, {
      code: "owner_snapshot_cleanup_unknown",
      indeterminate: true,
    });
  }
  return error;
}
export function captureSnapshotCalls(
  supplied: OwnerSnapshotPort | undefined,
  wrap: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
): OwnerSnapshotPort | undefined {
  if (!supplied) return undefined;
  const open = supplied.open.bind(supplied),
    read = supplied.read.bind(supplied),
    close = supplied.close.bind(supplied);
  return Object.freeze({
    open: (options) => wrap(() => open(options)),
    read: (id, request, options) =>
      wrap(() => read(id, structuredClone(request), options)),
    close: (id, options) => wrap(() => close(id, options)),
  });
}
export function createRegisteredReadSnapshot(
  options: Readonly<{
    collections: PluginRegistry["collections"];
    port?: OwnerSnapshotPort;
    signal: AbortSignal;
    check(): void;
    unsupported(): never;
    track<T>(work: () => Promise<T>): Promise<T>;
  }>,
) {
  const { collections, signal, check, unsupported, track } = options;
  const port = captureSnapshotCalls(options.port);
  let active = false;
  return <T>(
    callback: (
      scope: { collections: Record<string, unknown> },
    ) => T | Promise<T>,
  ): Promise<T> => {
    if (!port || typeof callback !== "function" || active) return unsupported();
    return track(async () => {
      if (active) return unsupported();
      active = true;
      let id: string | undefined, reading = false;
      const pending: Promise<unknown>[] = [];
      let result!: T, error: unknown, failed = false;
      const scopeCheck = () => {
        check();
        if (!reading) throw new Error("Snapshot callback is closed.");
      };
      try {
        id = await port.open({ signal });
        check();
        signal.throwIfAborted();
        reading = true;
        const scopeCollections = Object.fromEntries(
          Object.keys(collections).map((
            alias,
          ) => [
            alias,
            new Proxy(
              createCollectionReadCapability({
                alias,
                signal,
                check: scopeCheck,
                unsupported,
                read: (request, callOptions) =>
                  port.read(id!, request as unknown as OwnerJson, callOptions),
                track(work) {
                  scopeCheck();
                  const task = track(work);
                  pending.push(task);
                  return task;
                },
              }),
              {
                get(target, key) {
                  return Object.hasOwn(target, key)
                    ? Reflect.get(target, key)
                    : unsupported();
                },
              },
            ),
          ]),
        );
        result = await callback({
          collections: new Proxy(scopeCollections, {
            get(target, key) {
              return Object.hasOwn(target, key)
                ? Reflect.get(target, key)
                : unsupported();
            },
          }),
        });
      } catch (caught) {
        failed = true;
        error = caught;
      } finally {
        reading = false;
        try {
          // Parent revocation independently seals the owner if this call loses.
          if (id !== undefined) await port.close(id);
        } catch (caught) {
          error = failed || uncertain(caught)
            ? combineFailure(failed ? [error, caught] : [caught])
            : caught;
          failed = true;
        }
        for (const value of await Promise.allSettled(pending)) {
          if (value.status !== "rejected") continue;
          if (!failed) {
            failed = true;
            error = value.reason;
          } else if (uncertain(value.reason) && !uncertain(error)) {
            error = combineFailure([error, value.reason]);
          }
        }
        active = false;
      }
      if (failed) throw error;
      check();
      signal.throwIfAborted();
      return result;
    });
  };
}
