import { markOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
/** Bounded inert projections shared by the preparation boundary. */
import { assertJsonValue } from "../json.ts";
import type { CommandJson } from "../engine/commands.ts";
export function preparationError(code = "preparation_invalid"): never {
  throw Object.assign(new Error(code), { code });
}
/** Explicit owner policy refusal, distinct from malformed caller input or infrastructure. */
export function preparationRefusal(code: string): never {
  throw markOwnerAuthorizationRefusal(Object.assign(new Error(code), { code }));
}
export function preparationText(value: unknown): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024 ||
    [...value].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) preparationError();
  return value;
}
export function preparationData(
  value: unknown,
  maxBytes = 65_536,
): CommandJson {
  assertJsonValue(value, { maxDepth: 32, maxNodes: 20_000 });
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes) {
    preparationError("preparation_limit");
  }
  return structuredClone(value) as CommandJson;
}
export function preparationCanonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(preparationCanonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${
          preparationCanonical((value as Record<string, unknown>)[key])
        }`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
/** Projection may contain plain ContentRefs, but no protected envelopes, secret
 * markers, physical storage descriptors, executable values or capabilities. */
export function assertPreparationProjection(value: unknown): void {
  preparationData(value, 1_048_576);
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (
      record.schema === "copilotz.action.protected-value.v1" ||
      record.schema === "copilotz.action.lifecycle.protected.v1" ||
      record.type === "protected_value" ||
      record.type === "@copilotz/protected-value" ||
      record.kind === "protected" ||
      Object.hasOwn(record, "$copilotz-secret") ||
      Object.hasOwn(record, "$secret") ||
      Object.hasOwn(record, "protectedValue") ||
      Object.hasOwn(record, "ciphertext") ||
      Object.hasOwn(record, "location") && Object.hasOwn(record, "bodyId")
    ) preparationError("preparation_projection_unsafe");
    Object.values(item).forEach(visit);
  };
  visit(value);
}
