/** Private runtime capability for trusted bridge Processors. @module */

const protectedEventResolver = Symbol("copilotz.protected-event-resolver");

export type ProtectedEventResolver = () => Promise<unknown>;

export function withProtectedEventResolver<T extends object>(
  value: T,
  resolver: ProtectedEventResolver | undefined,
): T {
  if (!resolver) return value;
  return Object.defineProperty(value, protectedEventResolver, {
    value: resolver,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function protectedEventResolverFrom(
  context: object,
): ProtectedEventResolver | undefined {
  const resolver = (context as Record<PropertyKey, unknown>)[
    protectedEventResolver
  ];
  return typeof resolver === "function"
    ? resolver as ProtectedEventResolver
    : undefined;
}

/** Resolves the exact durable Event that caused this Action execution. */
export function resolveActionSourceData(context: object): Promise<unknown> {
  const resolver = protectedEventResolverFrom(context);
  if (!resolver) {
    throw new Error("Action source Event resolution is unavailable.");
  }
  return resolver();
}
