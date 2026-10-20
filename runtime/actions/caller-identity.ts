/** Private definition identity survives invocation-bound capability wrappers. */
const definitions = new WeakMap<object, string>();
export function recordActionCaller(value: object, id: string): void {
  definitions.set(value, id);
}
export function callerDefinition(value: unknown): string | undefined {
  return value && (typeof value === "function" || typeof value === "object")
    ? definitions.get(value as object)
    : undefined;
}
export function inheritActionCaller(source: object, target: object): void {
  const id = definitions.get(source);
  if (id) definitions.set(target, id);
}
