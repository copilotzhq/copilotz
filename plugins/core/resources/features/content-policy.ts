import {
  composeRoleContent,
  type ContentSequence,
  type DurableContentInput,
  type PreparedContent,
  replaceContentRoles,
  type RoleContentInput,
} from "@copilotz/copilotz/content";

export type RoleField = Readonly<{
  role: string;
  input?: DurableContentInput;
  cardinality?: "one" | "many";
}>;

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function contentSequence(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([...value]) as ContentSequence;
}

export function preparedContent(value: unknown): PreparedContent | undefined {
  return value && typeof value === "object" && !Array.isArray(value) &&
      Array.isArray((value as PreparedContent).content) &&
      Array.isArray((value as PreparedContent).assets)
    ? value as PreparedContent
    : undefined;
}

export function requiredText(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

export function persistRoleContent(
  current: ContentSequence,
  fields: readonly RoleField[],
): DurableContentInput {
  const active: RoleContentInput[] = fields.flatMap((field) =>
    field.input === undefined ? [] : [{
      role: field.role,
      input: field.input,
      ...(field.cardinality ? { cardinality: field.cardinality } : {}),
    }]
  );
  if (!active.length) return current;
  const replacement = composeRoleContent(active);
  return Object.freeze({
    content: replaceContentRoles(
      current,
      replacement.content,
      new Set(active.map((field) => field.role)),
    ),
    assets: replacement.assets,
  });
}
