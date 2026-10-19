import { orderedJson } from "../data-only-json.ts";
/** Owner-only capture of the complete registered Action output. */
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { assertSchemaCommandTransaction } from "../engine/commands.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  copy,
  fail,
  type PROTECTED_EFFECT_OUTPUT_SCHEMA,
} from "./effect-client.ts";
import {
  actionSchemaHasSecrets,
  rehydrateSecretActionValue,
  snapshotActionSchema,
  splitSecretActionValue,
} from "./secret.ts";
import {
  type PreparedProtectedValue,
  type ProtectedValueRef,
  protectedValueRef,
  type ProtectedValueRuntime,
} from "./protected-value.ts";
import type { ActionEffectOutcome, AnyActionDefinition } from "./types.ts";
import { sameActionValue } from "./value.ts";

export type ProtectedEffectOutput = Readonly<{
  schema: typeof PROTECTED_EFFECT_OUTPUT_SCHEMA;
  captureKey: string;
}>;
export type ActionOutputBinding = Readonly<{
  databaseSchema: string;
  namespace: string;
  actionRunId: string;
  action: AnyActionDefinition;
  protectedValues: ProtectedValueRuntime;
  /** Owner-local callbacks, never supplied by a worker. */
  authorize?(transaction: SqlExecutor): Promise<void>;
  accept?(output: ActionEffectOutcome, transaction: SqlExecutor): Promise<void>;
}>;
export type CapturedActionOutput = Readonly<{
  binding: Readonly<Record<string, unknown>>;
  publicValue: ActionEffectOutcome;
  ref: ProtectedValueRef;
}>;
export function actionOutputKey(
  binding: Pick<ActionOutputBinding, "namespace" | "actionRunId">,
): string {
  return JSON.stringify([
    "action-output",
    binding.namespace,
    binding.actionRunId,
    "output",
  ]);
}
function identity(binding: ActionOutputBinding) {
  if (!binding.action.outputSchema) {
    fail(
      "effect_output_schema_required",
      "A declared Action output schema is required.",
    );
  }
  return {
    databaseSchema: binding.databaseSchema,
    namespace: binding.namespace,
    ownerId: `${binding.action.id}:${binding.actionRunId}`,
    slot: "output",
    outputSchema: snapshotActionSchema(binding.action.outputSchema),
  } as const;
}
function coordinates(binding: ActionOutputBinding) {
  return {
    namespace: binding.namespace,
    ownerId: `${binding.action.id}:${binding.actionRunId}`,
    slot: "output",
  } as const;
}
/** Canonicalize only this new output capture format, preserving old lifecycle commitments. */
const canonicalOutput = (value: ActionEffectOutcome): ActionEffectOutcome =>
  orderedJson(value) as ActionEffectOutcome;
export function captureActionOutput(
  binding: ActionOutputBinding,
  value: ActionEffectOutcome,
): ActionEffectOutcome {
  const output = canonicalOutput(copy(value));
  try {
    validateAgainstJsonSchema(
      identity(binding).outputSchema,
      output,
      "Action output",
    );
    if (
      !actionSchemaHasSecrets(binding.action.outputSchema) && !binding.accept
    ) {
      fail("effect_output_invalid", "Protected Action output is required.");
    }
  } catch {
    fail(
      "effect_output_invalid",
      "Output does not match the registered protected Action schema.",
    );
  }
  return output;
}
export async function readCapturedActionOutput(
  tx: SqlExecutor,
  binding: ActionOutputBinding,
): Promise<CapturedActionOutput | undefined> {
  const tables = createCoreTableNames(binding.databaseSchema);
  const row = (await tx.query<{ intent: unknown; result: unknown }>(
    `SELECT intent,result FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND key=$1 AND kind='action.output.capture'`,
    [actionOutputKey(binding)],
  )).rows[0];
  if (!row) return;
  if (!sameActionValue(row.intent, identity(binding))) {
    fail(
      "effect_output_binding",
      "Retained Action output has a different binding.",
    );
  }
  const result = copy(row.result) as {
    publicValue: ActionEffectOutcome;
    ref: ProtectedValueRef;
  };
  if (!result || Object.keys(result).sort().join(",") !== "publicValue,ref") {
    fail("effect_output_binding", "Retained Action output is invalid.");
  }
  return {
    binding: identity(binding),
    publicValue: result.publicValue,
    ref: protectedValueRef(result.ref),
  };
}
export async function openCapturedActionOutput(
  binding: ActionOutputBinding,
  capture: CapturedActionOutput,
  transaction?: SqlExecutor,
): Promise<ActionEffectOutcome> {
  await binding.authorize?.(
    transaction ?? (() => {
      throw new Error(
        "Protected output authorization requires an owner transaction.",
      );
    })(),
  );
  if (!sameActionValue(capture.binding, identity(binding))) {
    fail(
      "effect_output_binding",
      "Retained Action output has a different binding.",
    );
  }
  try {
    const plaintext = await binding.protectedValues.open(
      coordinates(binding),
      capture.ref,
      transaction,
    );
    const output = rehydrateSecretActionValue(
      binding.action.outputSchema,
      capture.publicValue,
      plaintext,
    );
    return captureActionOutput(binding, output);
  } catch {
    fail(
      "effect_output_invalid",
      "Protected Action output could not be recovered.",
    );
  }
}
export async function assertCapturedActionOutput(
  binding: ActionOutputBinding,
  capture: CapturedActionOutput,
  output: ActionEffectOutcome,
  transaction?: SqlExecutor,
): Promise<void> {
  if (
    !sameActionValue(
      await openCapturedActionOutput(binding, capture, transaction),
      output,
    )
  ) {
    fail(
      "effect_output_conflict",
      "Action output differs from its accepted capture.",
    );
  }
}
export async function prepareCapturedActionOutput(
  binding: ActionOutputBinding,
  output: ActionEffectOutcome,
  transaction?: SqlExecutor,
): Promise<PreparedProtectedValue> {
  return await binding.protectedValues.prepare(
    coordinates(binding),
    output,
    transaction,
  );
}
export async function adoptCapturedActionOutput(
  tx: SqlExecutor,
  binding: ActionOutputBinding,
  output: ActionEffectOutcome,
  prepared: PreparedProtectedValue,
): Promise<CapturedActionOutput> {
  assertSchemaCommandTransaction(tx, binding.databaseSchema);
  await binding.authorize?.(tx);
  const prior = await readCapturedActionOutput(tx, binding);
  if (prior) {
    // The adapter commits to canonical plaintext, never randomized ciphertext.
    if (
      prior.ref.commitment !== prepared.ref.commitment ||
      !sameActionValue(
        prior.publicValue,
        splitSecretActionValue(binding.action.outputSchema, output).publicValue,
      )
    ) {
      fail(
        "effect_output_conflict",
        "Action output differs from its accepted capture.",
      );
    }
    return prior;
  }
  const tables = createCoreTableNames(binding.databaseSchema);
  const capture = {
    binding: identity(binding),
    publicValue:
      splitSecretActionValue(binding.action.outputSchema, output).publicValue,
    ref: prepared.ref,
  };
  await binding.protectedValues.adopt(
    { transaction: tx, tables },
    binding.namespace,
    prepared,
  );
  await binding.accept?.(output, tx);
  await tx.query(
    `INSERT INTO ${tables.owner_receipts} (owner,domain,key,principal,kind,intent,result) VALUES ('schema','logical',$1,'runtime','action.output.capture',$2::jsonb,$3::jsonb)`,
    [
      actionOutputKey(binding),
      JSON.stringify(capture.binding),
      JSON.stringify({ publicValue: capture.publicValue, ref: capture.ref }),
    ],
  );
  return capture;
}
