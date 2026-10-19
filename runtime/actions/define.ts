import {
  type ActionContentDeclaration,
  actionContentDeclaration,
} from "./content.ts";
import { actionDefinitionHasSecrets } from "./secret.ts";
import type {
  ActionContext,
  ActionDefinition,
  ActionDefinition as Definition,
  ActionSchema,
  AnyActionDefinition,
} from "./types.ts";
import type { ActionContinuation, OperationOutcome } from "./continuation.ts";
import { snapshotActionSchema } from "./secret.ts";

const ACTION_KEYS = new Set([
  "id",
  "ownerHooks",
  "content",
  "inputSchema",
  "outputSchema",
  "execute",
  "resume",
  "reconcile",
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
    typeof value.execute !== "function" ||
    (value.resume !== undefined && typeof value.resume !== "function") ||
    (value.reconcile !== undefined && typeof value.reconcile !== "function")
  ) return false;
  if (
    value.ownerHooks !== undefined &&
    (!isRecord(value.ownerHooks) || !Object.keys(value.ownerHooks).length ||
      Object.entries(value.ownerHooks).some(([key, value]) =>
        !["prepareInput", "acceptOutput"].includes(key) || value !== true
      ))
  ) return false;
  try {
    if (value.content !== undefined) actionContentDeclaration(value.content);
  } catch {
    return false;
  }
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
    ownerHooks?: Definition<TInput, TOutput, TContext>["ownerHooks"];
    content?: ActionContentDeclaration;
    inputSchema?: TInputSchema;
    outputSchema?: TOutputSchema;
    reconcile?: Definition<TInput, TOutput, TContext>["reconcile"];
    execute(
      input: TInput,
      context: TContext,
    ):
      | NoInfer<TOutput>
      | ActionContinuation
      | Promise<NoInfer<TOutput> | ActionContinuation>;
    resume(
      handoff: unknown,
      outcome: OperationOutcome,
      context: TContext,
    ): TOutput | ActionContinuation | Promise<TOutput | ActionContinuation>;
  }>,
): ActionDefinition<
  TInput,
  Awaited<TOutput> | ActionContinuation,
  TContext,
  TInputSchema,
  TOutputSchema
>;

export function defineAction<
  TInput = unknown,
  TOutput = unknown,
  TContext = ActionContext,
  const TInputSchema extends ActionSchema | undefined = undefined,
  const TOutputSchema extends ActionSchema | undefined = undefined,
>(
  definition: Readonly<{
    id: string;
    ownerHooks?: Definition<TInput, TOutput, TContext>["ownerHooks"];
    content?: ActionContentDeclaration;
    inputSchema?: TInputSchema;
    outputSchema?: TOutputSchema;
    reconcile?: Definition<TInput, TOutput, TContext>["reconcile"];
    execute(
      input: TInput,
      context: TContext,
    ): TOutput | Promise<TOutput>;
    resume?: Definition<TInput, TOutput, TContext>["resume"];
  }>,
): ActionDefinition<
  TInput,
  Awaited<TOutput>,
  TContext,
  TInputSchema,
  TOutputSchema
>;

export function defineAction<
  TInput = unknown,
  TOutput = unknown,
  TContext = ActionContext,
  const TInputSchema extends ActionSchema | undefined = undefined,
  const TOutputSchema extends ActionSchema | undefined = undefined,
>(
  definition: Readonly<{
    id: string;
    ownerHooks?: Definition<TInput, TOutput, TContext>["ownerHooks"];
    content?: ActionContentDeclaration;
    inputSchema?: TInputSchema;
    outputSchema?: TOutputSchema;
    reconcile?: Definition<TInput, TOutput, TContext>["reconcile"];
    execute(
      input: TInput,
      context: TContext,
    ): TOutput | Promise<TOutput>;
    resume?: Definition<TInput, TOutput, TContext>["resume"];
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
  if (
    definition.resume !== undefined && typeof definition.resume !== "function"
  ) {
    throw new TypeError(`Action '${id}' resume must be a function.`);
  }
  if (
    definition.reconcile !== undefined &&
    typeof definition.reconcile !== "function"
  ) {
    throw new TypeError(`Action '${id}' reconcile must be a function.`);
  }
  const ownerHooks = definition.ownerHooks;
  if (
    ownerHooks !== undefined &&
    (!isRecord(ownerHooks) || !Object.keys(ownerHooks).length ||
      Object.entries(ownerHooks).some(([key, value]) =>
        !["prepareInput", "acceptOutput"].includes(key) || value !== true
      ))
  ) {
    throw new TypeError(
      "Action ownerHooks must declare required owner phases.",
    );
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
  const content = definition.content === undefined
    ? undefined
    : actionContentDeclaration(definition.content);
  if (
    content &&
    actionDefinitionHasSecrets({
      id,
      inputSchema,
      outputSchema,
      execute: definition.execute as never,
    })
  ) {
    throw new TypeError(
      "Action content cannot yet be combined with secret schemas.",
    );
  }
  return ({
    id,
    ...(ownerHooks ? { ownerHooks: Object.freeze({ ...ownerHooks }) } : {}),
    ...(content ? { content } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    execute: definition.execute,
    ...(definition.reconcile ? { reconcile: definition.reconcile } : {}),
    ...(definition.resume ? { resume: definition.resume } : {}),
  } as const) as ActionDefinition<
    TInput,
    Awaited<TOutput>,
    TContext,
    TInputSchema,
    TOutputSchema
  >;
}
