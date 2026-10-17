/** Internal ordinary-data subset shared by owner preparation and startup.
 * Callers retain their aggregate JSON/byte budgets and authorization checks.
 * This guard is deliberately conservative: reserved reference/secret keys are
 * refused even when application data uses the same spelling innocently. It
 * neither grants permission nor opens, hydrates or recognizes new protocols.
 * Traversal is bounded to depth 32 and 20,000 nodes; schemas are never coerced.
 */
export const OWNER_PROTECTED_FAMILIES = [
  "copilotz.event.protected-value",
  "copilotz.action.lifecycle.protected",
  "copilotz.action.protected-value",
  "copilotz.action.protected-value-aad",
] as const;
export const OWNER_RESERVED_VALUE_KEYS = [
  "assetId",
  "bodyId",
  "ownerNodeId",
  "location",
  "$copilotz-secret",
  "$copilotz-protected",
  "x-copilotz-secret",
] as const;
const reservedKeys = new Set<string>(OWNER_RESERVED_VALUE_KEYS);
function refuse(): never {
  throw Object.assign(new Error("ordinary_value_unsupported"), {
    code: "ordinary_value_unsupported",
  });
}
/** Reserved protected-format family marker only. This does not validate a
 * protocol, inspect application field names, coerce a value or grant access. */
export function isOwnerProtectedSchemaFamily(value: unknown): boolean {
  return typeof value === "string" &&
    OWNER_PROTECTED_FAMILIES.some((family) =>
      value === family || value.startsWith(`${family}.`)
    );
}
/** Accepts only detached ordinary JSON, including null-prototype records.
 * Array-wrapped schema names also refuse; this does not coerce a schema value.
 * Cycles, capabilities, accessors, symbols and non-JSON values fail closed.
 */
export function assertOwnerOrdinaryValue(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number, schemaValue = false): void => {
    if (++nodes > 20_000 || depth > 32) refuse();
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) refuse();
      return;
    }
    if (typeof value === "string") {
      if (
        schemaValue &&
        isOwnerProtectedSchemaFamily(value)
      ) refuse();
      return;
    }
    if (typeof value !== "object" || ancestors.has(value)) refuse();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) refuse();
    if (Object.getOwnPropertySymbols(value).length) refuse();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(descriptors);
    if (names.length > 20_001) refuse();
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!("value" in descriptor)) refuse();
      if (array && name === "length") continue;
      if (!descriptor.enumerable || reservedKeys.has(name)) refuse();
    }
    if (array) {
      const length = descriptors.length.value;
      if (
        !Number.isSafeInteger(length) || length < 0 || length > 20_000 ||
        names.length !== length + 1
      ) refuse();
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(descriptors, String(index))) refuse();
      }
    }
    ancestors.add(value);
    for (const name of names) {
      if (array && name === "length") continue;
      visit(
        descriptors[name].value,
        depth + 1,
        name === "schema" || (array && schemaValue),
      );
    }
    ancestors.delete(value);
  };
  visit(value, 0);
}
