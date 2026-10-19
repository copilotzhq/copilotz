/** Authorized Collection snapshots use the canonical observation decoder and request path. */
import type { ObserveOptions } from "./index.ts";
import { ProtocolError } from "./protocol.ts";

export type CollectionObserveSelection = Readonly<
  { id: string; query?: never; queryName?: never } | {
    id?: never;
    query: Readonly<Record<string, unknown>>;
    queryName?: never;
  } | {
    id?: never;
    query?: never;
    queryName: string;
    input: Readonly<Record<string, unknown>>;
  }
>;
export type CollectionSnapshot = Readonly<{
  collection: string;
  reset: boolean;
  from?: string;
  to: string;
  value: unknown;
  status: "ready" | "missing";
  pending: false;
  checkpoint: string;
}>;
export type CollectionObserveOptions = Readonly<{
  checkpoint?: string;
  signal?: AbortSignal;
  onSnapshot(snapshot: CollectionSnapshot): void | Promise<void>;
}>;
export type CollectionObserver = (
  collection: string,
  selection: CollectionObserveSelection,
  options: CollectionObserveOptions,
) => Promise<string | undefined>;

export function createCollectionObserver(
  observe: (
    path: string,
    selection: unknown,
    options: ObserveOptions,
  ) => Promise<string | undefined>,
): CollectionObserver {
  return (collection, selection, options) => {
    if (!collection || collection === "." || collection === "..") {
      throw new TypeError("Invalid Collection name.");
    }
    let applied: string | undefined;
    return observe(
      `/collections/${encodeURIComponent(collection)}/observe`,
      selection,
      {
        checkpoint: options.checkpoint,
        signal: options.signal,
        async onFrame(frame) {
          if (frame.kind !== "output") {
            throw new ProtocolError(
              "Unexpected Collection observation frame.",
            );
          }
          const output = frame.output;
          if (
            output.type !== "collection.snapshot" ||
            output.collection !== collection ||
            typeof output.reset !== "boolean" ||
            typeof output.to !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(output.to) ||
            (output.status !== "ready" && output.status !== "missing") ||
            output.pending !== false ||
            !Object.hasOwn(output, "value")
          ) {
            throw new ProtocolError("Invalid Collection snapshot.");
          }
          if (output.reset) {
            if (output.from !== undefined) {
              throw new ProtocolError(
                "A reset snapshot cannot continue an older range.",
              );
            }
          } else if (
            applied === undefined || output.from !== applied ||
            BigInt(output.to) < BigInt(applied)
          ) {
            throw new ProtocolError("Collection snapshot coverage has a gap.");
          }
          await options.onSnapshot({
            collection,
            reset: output.reset,
            ...(output.from === undefined
              ? {}
              : { from: output.from as string }),
            to: output.to,
            value: output.value,
            status: output.status,
            pending: false,
            checkpoint: frame.checkpoint,
          });
          applied = output.to;
        },
      },
    );
  };
}
