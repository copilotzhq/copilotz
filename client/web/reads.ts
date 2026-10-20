import type { CollectionContentOptions } from "../../runtime/collections/read-options.ts";
/** Browser read selection; live state and transport are supplied by the SDK. */
export type Row = Readonly<{ id: string; [field: string]: unknown }>;
export type ReadRequest = Readonly<{
  collection: string;
  progressOnly?: boolean;
  content?: CollectionContentOptions;
  id?: string;
  query?: Readonly<Record<string, unknown>>;
}>;
export function readKey(read: ReadRequest): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
          [key, value],
        ) => [key, canonical(value)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(read));
}
