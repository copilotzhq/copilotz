const ACTION_ALIAS = /^[a-z][a-zA-Z0-9_]*$/;
const UNSAFE_ALIASES = new Set(["__proto__", "constructor", "prototype"]);

/** Preserves valid provider aliases and normalizes only invalid input. */
export function generatedActionAlias(
  value: string,
  prefix = "tool",
): string {
  const raw = value.trim();
  if (ACTION_ALIAS.test(raw) && !UNSAFE_ALIASES.has(raw)) return raw;
  let alias = raw
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-zA-Z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  if (!alias || !/^[a-z]/.test(alias)) alias = `${prefix}_${alias}`;
  if (!ACTION_ALIAS.test(alias) || UNSAFE_ALIASES.has(alias)) {
    throw new TypeError(`Cannot derive an Action alias from '${value}'.`);
  }
  return alias;
}

/** Produces a stable Action-id segment from externally supplied identifiers. */
export function generatedActionIdSegment(
  value: string,
  fallback = "generated",
): string {
  const segment = value.trim().toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return segment || fallback;
}

export function assertGeneratedEntryUnique(
  seenAliases: Set<string>,
  seenActionIds: Set<string>,
  alias: string,
  actionId: string,
  source: string,
): void {
  if (seenAliases.has(alias)) {
    throw new TypeError(
      `Generated Tool alias collision '${alias}' from ${source}.`,
    );
  }
  if (seenActionIds.has(actionId)) {
    throw new TypeError(
      `Generated Tool Action id collision '${actionId}' from ${source}.`,
    );
  }
  seenAliases.add(alias);
  seenActionIds.add(actionId);
}
