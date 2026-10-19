import { assertJsonValue } from "../json.ts";

/** Deterministic bytes for newly authored inline JSON; existing refs are untouched. */
export function canonicalContentJson(value: unknown): string {
  assertJsonValue(value, {
    label: "Inline JSON content",
    maxDepth: 64,
    maxNodes: 100_000,
  });
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) {
      const values: string[] = [];
      for (let index = 0; index < item.length; index++) {
        values.push(encode(item[index]));
      }
      return `[${values.join(",")}]`;
    }
    if (item && typeof item === "object") {
      return `{${
        Object.keys(item).sort().map((key) =>
          `${JSON.stringify(key)}:${
            encode((item as Record<string, unknown>)[key])
          }`
        ).join(",")
      }}`;
    }
    return JSON.stringify(item);
  };
  return encode(value);
}
