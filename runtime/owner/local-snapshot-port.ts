/** Bind existing owner resources to the existing local raw-call tracker. */
import type { OwnerCaller } from "./boundary.ts";
import type { OwnerSnapshotPort } from "./connection.ts";
import type { createOwnerSnapshotResources } from "./snapshot.ts";
import type { createLocalPortCalls } from "./local-port-calls.ts";
export type LocalSnapshotResources = Pick<
  ReturnType<typeof createOwnerSnapshotResources>,
  "open" | "read" | "close" | "assertOrdinaryAllowed"
>;
export function createLocalSnapshotPort(
  options: Readonly<{
    resources?: LocalSnapshotResources;
    caller: OwnerCaller;
    calls: Pick<ReturnType<typeof createLocalPortCalls>, "run">;
    check(): void;
  }>,
): OwnerSnapshotPort | undefined {
  const source = options.resources;
  if (!source) return undefined;
  const caller = structuredClone(options.caller), { calls, check } = options;
  const open = source.open.bind(source),
    read = source.read.bind(source),
    close = source.close.bind(source);
  return {
    async open(callOptions) {
      check();
      const result = await calls.run(
        (execution) => open(structuredClone(caller), execution.signal),
        callOptions,
      );
      check();
      return result;
    },
    async read(id, request, callOptions) {
      check();
      const data = structuredClone(request);
      const result = await calls.run(
        (execution) =>
          read(id, structuredClone(caller), data, execution.signal),
        callOptions,
      );
      check();
      return result;
    },
    async close(id, callOptions) {
      check();
      await calls.run(() => close(id, structuredClone(caller)), callOptions);
      check();
    },
  };
}
