/** Shared Knowledge input contracts and operations. @module */

export function record(
  value: unknown,
  name = "Input",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function optional(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

export function finiteVector(value: unknown, name: string): readonly number[] {
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.some((item) => !Number.isFinite(item))
  ) {
    throw new TypeError(`${name} must be a non-empty finite vector.`);
  }
  return (value.map(Number));
}
