/** Canonical JSON for replay and no-op comparison. Key order is not semantic. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",")
  }}`;
}

export function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}
