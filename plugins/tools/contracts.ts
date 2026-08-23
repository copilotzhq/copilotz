import type {
  ActionSchema,
  AnyActionDefinition,
} from "@copilotz/copilotz/actions";

const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const UNSAFE_ALIASES = new Set(["__proto__", "constructor", "prototype"]);
const PRESENTATION_KEYS = new Set([
  "name",
  "description",
  "history",
  "metadata",
]);
const HISTORY_KEYS = new Set(["visibility"]);

export type ToolHistoryVisibility =
  | "requester_only"
  | "public_status"
  | "public";

export type ToolHistory = Readonly<{
  visibility?: ToolHistoryVisibility;
}>;

/**
 * Data-only LLM presentation for an existing Action. For a resource registered
 * as `resources.tools.search`, `action` must be the same `search` alias used by
 * `context.actions.search`; Core validates that composition invariant.
 */
export type ToolResource<TAction extends string = string> = Readonly<{
  action: TAction;
  name: string;
  description: string;
  inputSchema?: ActionSchema;
  outputSchema?: ActionSchema;
  history?: ToolHistory;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ToolPresentation = Readonly<{
  name: string;
  description: string;
  history?: ToolHistory;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type DefinedToolResource<
  TAlias extends string,
  TAction extends AnyActionDefinition,
  TPresentation extends ToolPresentation,
> =
  & ToolResource<TAlias>
  & Readonly<{
    action: TAlias;
    name: TPresentation["name"];
    description: TPresentation["description"];
    inputSchema?: TAction["inputSchema"];
    outputSchema?: TAction["outputSchema"];
    history?: TPresentation["history"];
    metadata?: TPresentation["metadata"];
  }>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new TypeError(`${label} cannot declare '${unknown}'.`);
}

function alias(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized !== value || !ALIAS_PATTERN.test(normalized) ||
    UNSAFE_ALIASES.has(normalized)
  ) {
    throw new TypeError(`Tool has invalid Action alias '${String(value)}'.`);
  }
  return normalized;
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`Tool ${label} is required.`);
  if (normalized !== value) {
    throw new TypeError(
      `Tool ${label} must not contain surrounding whitespace.`,
    );
  }
  return value as string;
}

function schema(
  value: unknown,
  name: "inputSchema" | "outputSchema",
): ActionSchema | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError(`Tool Action ${name} must be a JSON Schema object.`);
  }
  return value as ActionSchema;
}

function history(value: unknown): ToolHistory | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError("Tool history must be an object.");
  }
  assertKnownKeys(value, HISTORY_KEYS, "Tool history");
  if (
    value.visibility !== undefined &&
    value.visibility !== "requester_only" &&
    value.visibility !== "public_status" &&
    value.visibility !== "public"
  ) {
    throw new TypeError(
      `Tool history has invalid visibility '${String(value.visibility)}'.`,
    );
  }
  return Object.freeze({
    ...(value.visibility !== undefined
      ? { visibility: value.visibility as ToolHistoryVisibility }
      : {}),
  });
}

function metadata(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError("Tool metadata must be an object.");
  }
  return Object.freeze({ ...value });
}

/**
 * Optional convenience that copies an Action's schemas into its ordinary Tool
 * Resource presentation. It neither registers nor executes either value.
 */
export function defineTool<
  const TAlias extends string,
  const TAction extends AnyActionDefinition,
  const TPresentation extends ToolPresentation,
>(
  actionAlias: TAlias,
  actionDefinition: TAction,
  presentation: TPresentation,
): DefinedToolResource<TAlias, TAction, TPresentation> {
  const normalizedAlias = alias(actionAlias);
  if (!isPlainRecord(actionDefinition)) {
    throw new TypeError("Tool Action definition must be an object.");
  }
  if (
    typeof actionDefinition.id !== "string" || !actionDefinition.id.trim() ||
    typeof actionDefinition.execute !== "function"
  ) {
    throw new TypeError("Tool requires an Action definition.");
  }
  const inputSchema = schema(actionDefinition.inputSchema, "inputSchema");
  const outputSchema = schema(actionDefinition.outputSchema, "outputSchema");
  if (!isPlainRecord(presentation)) {
    throw new TypeError("Tool presentation must be an object.");
  }
  assertKnownKeys(presentation, PRESENTATION_KEYS, "Tool presentation");
  const normalizedHistory = history(presentation.history);
  const normalizedMetadata = metadata(presentation.metadata);
  return Object.freeze({
    action: normalizedAlias,
    name: requiredText(presentation.name, "name"),
    description: requiredText(presentation.description, "description"),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(normalizedHistory ? { history: normalizedHistory } : {}),
    ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
  }) as DefinedToolResource<TAlias, TAction, TPresentation>;
}
