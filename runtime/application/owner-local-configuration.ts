/** Closed inert configuration capture shared by private local host composition. */
export function ownConfiguration(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(
      "Private local configuration requires a plain own-data object.",
    );
  }
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" || !descriptor?.enumerable ||
      !("value" in descriptor) ||
      ![...required, ...optional].includes(key)
    ) {
      throw new TypeError(
        "Private local configuration requires closed own-data fields.",
      );
    }
    captured[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(captured, key))) {
    throw new TypeError("Private local configuration is incomplete.");
  }
  return captured;
}
