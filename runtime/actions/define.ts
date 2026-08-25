import type {
  ActionContext,
  ActionDefinition,
  ActionSchema,
  AnyActionDefinition,
} from "./types.ts";
import { snapshotActionSchema } from "./secret.ts";

const ACTION_KEYS = new Set([
  "id",
  "inputSchema",
  "outputSchema",
  "execute",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function actionId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new TypeError("Action id is required.");
  if (!/^[a-z][a-z0-9_.-]*$/i.test(id)) {
    throw new TypeError(`Action id '${id}' cannot form an event type.`);
  }
  return id;
}

function optionalSchema(
  id: string,
  name: "inputSchema" | "outputSchema",
  value: unknown,
): ActionSchema | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(`Action '${id}' ${name} must be a JSON Schema object.`);
  }
  return snapshotActionSchema(value as ActionSchema);
}

export function isActionDefinition(
  value: unknown,
): value is AnyActionDefinition {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some((key) => !ACTION_KEYS.has(key)) ||
    typeof value.id !== "string" || !value.id.trim() ||
    !/^[a-z][a-z0-9_.-]*$/i.test(value.id.trim()) ||
    typeof value.execute !== "function"
  ) return false;
  return (value.inputSchema === undefined || isRecord(value.inputSchema)) &&
    (value.outputSchema === undefined || isRecord(value.outputSchema));
}

/** Validates and freezes one Action definition. */
export function defineAction<
  TInput = unknown,
  TOutput = unknown,
  TContext = ActionContext,
  const TInputSchema extends ActionSchema | undefined = undefined,
  const TOutputSchema extends ActionSchema | undefined = undefined,
>(
  definition: Readonly<{
    id: string;
    inputSchema?: TInputSchema;
    outputSchema?: TOutputSchema;
    execute(
      input: TInput,
      context: TContext,
    ): TOutput | Promise<TOutput>;
  }>,
): ActionDefinition<
  TInput,
  Awaited<TOutput>,
  TContext,
  TInputSchema,
  TOutputSchema
> {
  if (!isRecord(definition)) {
    throw new TypeError("Action definition must be an object.");
  }
  const id = actionId(definition.id);
  const unknown = Object.keys(definition).find((key) => !ACTION_KEYS.has(key));
  if (unknown) {
    throw new TypeError(`Action '${id}' cannot declare '${unknown}'.`);
  }
  if (typeof definition.execute !== "function") {
    throw new TypeError(`Action '${id}' requires execute.`);
  }
  const inputSchema = optionalSchema(
    id,
    "inputSchema",
    definition.inputSchema,
  );
  const outputSchema = optionalSchema(
    id,
    "outputSchema",
    definition.outputSchema,
  );
  return Object.freeze({
    id,
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    execute: definition.execute,
  }) as ActionDefinition<
    TInput,
    Awaited<TOutput>,
    TContext,
    TInputSchema,
    TOutputSchema
  >;
}
