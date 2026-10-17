/** Placement-neutral plain reads; the bound driver retains real call lifetime. */
import { assertOwnerOrdinaryValue } from "../owner/ordinary-value.ts";
import { assertJsonValue } from "../json.ts";
import { parseOwnerCollectionReadRequest } from "./collection-read-call.ts";
import type { RegisteredInvocationCalls } from "./registered-invocation.ts";

export function createCollectionReadCapability(
  options: Readonly<{
    alias: string;
    read: RegisteredInvocationCalls["readCollection"];
    signal: AbortSignal;
    check(): void;
    unsupported(): never;
    track<T>(start: () => Promise<T>): Promise<T>;
  }>,
) {
  const { alias, read, signal, check, unsupported, track } = options;
  const run = (
    operation: "get" | "list" | "aggregate",
    input: unknown,
    callOptions: unknown,
  ) =>
    track(async () => {
      if (!read) return unsupported();
      const extra = callOptions === undefined ? {} : callOptions;
      if (
        !extra || typeof extra !== "object" || Array.isArray(extra)
      ) return unsupported();
      const descriptors = Object.getOwnPropertyDescriptors(extra);
      if (
        Object.getOwnPropertySymbols(extra).length ||
        Object.entries(descriptors).some(([key, d]) =>
          !["signal", "content"].includes(key) || !("value" in d)
        )
      ) return unsupported();
      const content = descriptors.content?.value;
      const cancelled = descriptors.signal?.value;
      if (
        content !== undefined && content !== false ||
        cancelled !== undefined && !(cancelled instanceof AbortSignal)
      ) return unsupported();
      if (
        operation === "get" && (!input || typeof input !== "object" ||
          Array.isArray(input) || Object.keys(input).some((key) =>
            key !== "id"
          ))
      ) {
        return unsupported();
      }
      if (operation === "get") assertJsonValue(input);
      const request = parseOwnerCollectionReadRequest(
        operation === "get"
          ? {
            collectionAlias: alias,
            operation,
            id: (input as { id?: unknown }).id,
          }
          : {
            collectionAlias: alias,
            operation,
            query: input === undefined ? {} : input,
          },
      );
      const combined = cancelled
        ? AbortSignal.any([signal, cancelled])
        : signal;
      combined.throwIfAborted();
      const result = await read(request, { signal: combined });
      check();
      combined.throwIfAborted();
      assertOwnerOrdinaryValue(result);
      if (
        operation === "get"
          ? result !== null &&
            (typeof result !== "object" || Array.isArray(result))
          : !Array.isArray(result)
      ) return unsupported();
      if (
        new TextEncoder().encode(JSON.stringify(result)).length > 1_048_576
      ) return unsupported();
      return structuredClone(result);
    });
  return {
    get: (input: unknown, extra?: unknown) => run("get", input, extra),
    list: (input?: unknown, extra?: unknown) => run("list", input, extra),
    aggregate: (input: unknown, extra?: unknown) =>
      run("aggregate", input, extra),
  };
}
