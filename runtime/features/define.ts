import type {
  AnyFeatureDefinition,
  ErasedFeatureAction,
  FeatureActionMap,
  FeatureDefinition,
} from "./types.ts";

function requireText(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${name} is required.`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectLegacyShape(input: Record<string, unknown>, id: string): void {
  if ("alias" in input) {
    throw new TypeError(
      `Feature '${id}' cannot declare alias. Use the Feature id and call context.feature(definition).`,
    );
  }
  if ("mode" in input) {
    throw new TypeError(
      `Feature '${id}' cannot declare resource-wide mode.`,
    );
  }
}

function requireSchema(
  featureId: string,
  actionName: string,
  field: "inputSchema" | "outputSchema",
  value: unknown,
): object | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' ${field} must be a JSON Schema object.`,
    );
  }
  return value;
}

function validateDescriptor(
  featureId: string,
  actionName: string,
  value: Record<string, unknown>,
): ErasedFeatureAction {
  if ("effect" in value) {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' cannot declare effect. Use context.transaction() for atomic graph writes.`,
    );
  }
  if ("requires" in value) {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' cannot declare requires. Look up dependencies from context in code.`,
    );
  }
  if ("content" in value) {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' cannot declare content fields. Collections own assetizable fields.`,
    );
  }
  if ("input" in value) {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' cannot declare input. Use inputSchema for validation metadata.`,
    );
  }
  if ("output" in value) {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' cannot declare output. Use outputSchema for validation metadata.`,
    );
  }
  if (typeof value.execute !== "function") {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' requires execute.`,
    );
  }
  const inputSchema = requireSchema(
    featureId,
    actionName,
    "inputSchema",
    value.inputSchema,
  );
  const outputSchema = requireSchema(
    featureId,
    actionName,
    "outputSchema",
    value.outputSchema,
  );
  return Object.freeze({
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    execute: value.execute as ErasedFeatureAction["execute"],
  });
}

function validateAction(
  featureId: string,
  actionName: string,
  value: unknown,
): ErasedFeatureAction {
  if (typeof value === "function") {
    return Object.freeze({
      execute: value as ErasedFeatureAction["execute"],
    });
  }
  if (!isRecord(value)) {
    throw new TypeError(
      `Feature '${featureId}' action '${actionName}' must be a function or descriptor.`,
    );
  }
  return validateDescriptor(featureId, actionName, value);
}

type NormalizedAction<A> = A extends (...args: never[]) => unknown
  ? Readonly<{ execute: A }>
  : A extends ErasedFeatureAction ? A
  : never;

type NormalizedActions<TActions extends FeatureActionMap> = {
  readonly [K in keyof TActions]: NormalizedAction<TActions[K]>;
};

export function isFeatureDefinition(
  value: unknown,
): value is AnyFeatureDefinition {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return false;
  }
  if ("alias" in value || "mode" in value) return false;
  if (!isRecord(value.actions)) return false;
  return Object.values(value.actions).every((action) => {
    if (!isRecord(action) || typeof action.execute !== "function") return false;
    if (
      "effect" in action || "requires" in action || "content" in action ||
      "input" in action || "output" in action
    ) {
      return false;
    }
    if (
      action.inputSchema !== undefined && !isRecord(action.inputSchema)
    ) return false;
    if (
      action.outputSchema !== undefined && !isRecord(action.outputSchema)
    ) return false;
    return true;
  });
}

/** Validates and freezes one static Feature definition. */
export function defineFeature<
  const TActions extends FeatureActionMap,
>(
  definition: Readonly<{
    id: string;
    actions: TActions;
  }>,
): FeatureDefinition<NormalizedActions<TActions>> {
  if (!isRecord(definition)) {
    throw new TypeError("Feature definition must be an object.");
  }
  const id = requireText(definition.id, "Feature id");
  rejectLegacyShape(definition as Record<string, unknown>, id);
  if (
    !isRecord(definition.actions) ||
    Object.keys(definition.actions).length === 0
  ) {
    throw new TypeError(`Feature '${id}' requires at least one action.`);
  }
  const actions = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.actions).map(([name, action]) => {
        const actionName = requireText(name, `Feature '${id}' action name`);
        return [actionName, validateAction(id, actionName, action)];
      }),
    ),
  ) as unknown as NormalizedActions<TActions>;
  return Object.freeze({ id, actions });
}
