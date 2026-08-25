/** Internal protected representation of one Action lifecycle Event Body. @module */

import type { ActionEventData, AnyActionDefinition } from "./types.ts";
import {
  actionSchemaHasSecrets,
  rehydrateSecretActionValue,
  splitSecretActionValue,
} from "./secret.ts";
import {
  type PreparedProtectedValue,
  type ProtectedValueRef,
  protectedValueRef,
  type ProtectedValueRuntime,
} from "./protected-value.ts";
import { durableActionValue, sameActionValue } from "./value.ts";

export const PROTECTED_ACTION_LIFECYCLE_SCHEMA =
  "copilotz.action.lifecycle.protected.v1" as const;

export type ProtectedActionLifecycleBody = Readonly<{
  schema: typeof PROTECTED_ACTION_LIFECYCLE_SCHEMA;
  data: ActionEventData;
  protected: Readonly<{
    input?: ProtectedValueRef;
    output?: ProtectedValueRef;
  }>;
}>;

export type PreparedActionLifecycleBody = Readonly<{
  body: ActionEventData | ProtectedActionLifecycleBody;
  publicData: ActionEventData;
  prepared: readonly PreparedProtectedValue[];
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function definitionById(
  actions: Readonly<Record<string, AnyActionDefinition>>,
  actionId: string,
): AnyActionDefinition | undefined {
  return Object.values(actions).find((action) => action.id === actionId);
}

export function actionDefinitionById(
  actions: Readonly<Record<string, AnyActionDefinition>>,
  actionId: string,
): AnyActionDefinition {
  const definition = definitionById(actions, actionId);
  if (!definition) {
    throw new Error(
      `Action lifecycle references unknown Action '${actionId}'.`,
    );
  }
  return definition;
}

export function actionDefinitionHasSecrets(
  action: AnyActionDefinition,
): boolean {
  return actionSchemaHasSecrets(action.inputSchema) ||
    actionSchemaHasSecrets(action.outputSchema);
}

export function protectedActionLifecycleBody(
  value: unknown,
): ProtectedActionLifecycleBody | null {
  const input = record(value);
  if (input.schema !== PROTECTED_ACTION_LIFECYCLE_SCHEMA) return null;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 3 ||
    keys.some((key) =>
      key !== "schema" && key !== "data" && key !== "protected"
    )
  ) throw new TypeError("Protected Action lifecycle body is invalid.");
  const protectedFields = record(input.protected);
  if (
    Reflect.ownKeys(protectedFields).some((key) =>
      key !== "input" && key !== "output"
    ) ||
    (protectedFields.input === undefined &&
      protectedFields.output === undefined)
  ) throw new TypeError("Protected Action lifecycle references are invalid.");
  const data = durableActionValue(input.data) as ActionEventData;
  return Object.freeze({
    schema: PROTECTED_ACTION_LIFECYCLE_SCHEMA,
    data,
    protected: Object.freeze({
      ...(protectedFields.input !== undefined
        ? { input: protectedValueRef(protectedFields.input) }
        : {}),
      ...(protectedFields.output !== undefined
        ? { output: protectedValueRef(protectedFields.output) }
        : {}),
    }),
  });
}

/** Returns the observer/processor-safe lifecycle data for any stored body. */
export function publicActionLifecycleData(value: unknown): unknown {
  return protectedActionLifecycleBody(value)?.data ?? value;
}

export function protectedActionLifecycleRefs(
  value: unknown,
): readonly ProtectedValueRef[] {
  const body = protectedActionLifecycleBody(value);
  if (!body) return Object.freeze([]);
  return Object.freeze(
    [body.protected.input, body.protected.output].filter(
      (ref): ref is ProtectedValueRef => ref !== undefined,
    ),
  );
}

function coordinates(
  namespace: string,
  data: ActionEventData,
  slot: "input" | "output",
) {
  return Object.freeze({
    namespace,
    ownerId: `${data.actionId}:${data.actionRunId}`,
    slot,
  });
}

/** Seals secret-bearing sides and constructs the safe durable representation. */
export async function prepareActionLifecycleBody(
  input: Readonly<{
    namespace: string;
    data: ActionEventData;
    action: AnyActionDefinition;
    protectedValues?: ProtectedValueRuntime;
    existingInput?: ProtectedValueRef;
  }>,
): Promise<PreparedActionLifecycleBody> {
  const data = input.data;
  const inputSplit = splitSecretActionValue(
    input.action.inputSchema,
    data.input,
  );
  const outputSplit = data.status === "completed"
    ? splitSecretActionValue(input.action.outputSchema, data.output)
    : undefined;
  if ((inputSplit.secret || outputSplit?.secret) && !input.protectedValues) {
    throw new Error(
      `Action '${input.action.id}' requires a configured Secret Adapter.`,
    );
  }

  const prepared: PreparedProtectedValue[] = [];
  let inputRef = input.existingInput;
  if (inputSplit.secret && !inputRef) {
    const value = await input.protectedValues!.prepare(
      coordinates(input.namespace, input.data, "input"),
      data.input,
    );
    prepared.push(value);
    inputRef = value.ref;
  }
  if (!inputSplit.secret && inputRef) {
    throw new Error("Protected Action input reference is unexpected.");
  }
  let outputRef: ProtectedValueRef | undefined;
  if (data.status === "completed" && outputSplit?.secret) {
    const value = await input.protectedValues!.prepare(
      coordinates(input.namespace, data, "output"),
      data.output,
    );
    prepared.push(value);
    outputRef = value.ref;
  }

  const publicData = Object.freeze({
    ...data,
    input: inputSplit.publicValue,
    ...(data.status === "completed"
      ? { output: outputSplit!.publicValue }
      : {}),
  }) as ActionEventData;
  if (!inputRef && !outputRef) {
    return Object.freeze({
      body: publicData,
      publicData,
      prepared: Object.freeze([]),
    });
  }
  return Object.freeze({
    body: Object.freeze({
      schema: PROTECTED_ACTION_LIFECYCLE_SCHEMA,
      data: publicData,
      protected: Object.freeze({
        ...(inputRef ? { input: inputRef } : {}),
        ...(outputRef ? { output: outputRef } : {}),
      }),
    }),
    publicData,
    prepared: Object.freeze(prepared),
  });
}

/** Opens and validates one authoritative stored lifecycle receipt. */
export async function hydrateActionLifecycleBody(
  input: Readonly<{
    namespace: string;
    body: ActionEventData | ProtectedActionLifecycleBody;
    action: AnyActionDefinition;
    protectedValues?: ProtectedValueRuntime;
  }>,
): Promise<ActionEventData> {
  const protectedBody = protectedActionLifecycleBody(input.body);
  if (!protectedBody) return durableActionValue(input.body) as ActionEventData;
  if (!input.protectedValues) {
    throw new Error(
      `Action '${input.action.id}' requires a configured Secret Adapter.`,
    );
  }
  const data = protectedBody.data;
  let hydratedInput = data.input;
  if (protectedBody.protected.input) {
    const plaintext = await input.protectedValues.open(
      coordinates(input.namespace, data, "input"),
      protectedBody.protected.input,
    );
    hydratedInput = rehydrateSecretActionValue(
      input.action.inputSchema,
      data.input,
      plaintext,
    );
  }
  let hydratedOutput: unknown;
  if (data.status === "completed") {
    hydratedOutput = data.output;
    if (protectedBody.protected.output) {
      const plaintext = await input.protectedValues.open(
        coordinates(input.namespace, data, "output"),
        protectedBody.protected.output,
      );
      hydratedOutput = rehydrateSecretActionValue(
        input.action.outputSchema,
        data.output,
        plaintext,
      );
    }
  } else if (protectedBody.protected.output) {
    throw new Error("Only completed Actions may own a protected output.");
  }
  return Object.freeze({
    ...data,
    input: hydratedInput,
    ...(data.status === "completed" ? { output: hydratedOutput } : {}),
  }) as ActionEventData;
}

/** Duplicate equivalence ignores randomized ciphertext identity. */
export function samePreparedActionLifecycleBody(
  leftValue: unknown,
  rightValue: unknown,
): boolean {
  const left = protectedActionLifecycleBody(leftValue);
  const right = protectedActionLifecycleBody(rightValue);
  if (!left || !right) return sameActionValue(leftValue, rightValue);
  return sameActionValue(left.data, right.data) &&
    left.protected.input?.commitment === right.protected.input?.commitment &&
    left.protected.output?.commitment === right.protected.output?.commitment;
}
