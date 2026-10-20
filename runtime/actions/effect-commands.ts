/** The sole owner-fenced durable external-effect state machine. */
import {
  type CommandContext,
  createSchemaCommandRunner,
} from "../engine/commands.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { sameActionValue } from "./value.ts";
import { snapshotActionSchema, splitSecretActionValue } from "./secret.ts";
import type {
  ActionEffectEvidence,
  ActionEffectOutcome,
  ActionEffectState,
  AnyActionDefinition,
} from "./types.ts";
import {
  type ActionEffectClient,
  bindCapturedConfirmation,
  copy,
  type EffectInventoryEntry,
  effectKey,
  type EffectReference,
  evidence,
  fail,
  text,
  validateEffectData,
} from "./effect-client.ts";

type EffectRow = {
  step: string;
  status: "begun" | "confirmed" | "not_started";
  outcome: ActionEffectOutcome | null;
  evidence: ActionEffectEvidence | null;
};
function state(row?: EffectRow): ActionEffectState {
  if (!row) return { status: "none" };
  if (row.status === "confirmed") {
    return { status: "replay", outcome: copy(row.outcome) };
  }
  if (row.status === "begun") return { status: "indeterminate" };
  if (row.status === "not_started") return { status: "not_started" };
  return fail("effect_state_invalid", "Invalid retained effect state.");
}
/** Retained steps belonging to this Action, including steps removed by new code. */
export async function readActionEffectInventory(
  transaction: SqlExecutor,
  scope: { schema: string; namespace: string; actionRunId: string },
): Promise<readonly EffectInventoryEntry[]> {
  return (await transaction.query<EffectInventoryEntry>(
    `SELECT step,status FROM ${
      createCoreTableNames(scope.schema).action_effects
    }
     WHERE namespace=$1 AND action_run_id=$2 ORDER BY step`,
    [scope.namespace, scope.actionRunId],
  )).rows;
}

export function createOwnerEffectClient(
  options: Readonly<{
    session: SqlExecutor;
    schema: string;
    namespace: string;
    actionRunId: string;
    writer?: Readonly<{ deliveryId: string; leaseOwner: string }>;
    signal?: AbortSignal;
    /** Trusted owner-only verifier; a worker's evidence assertion is never proof. */
    verifyNotStarted?(
      transaction: SqlExecutor,
      ref: EffectReference,
      proof: ActionEffectEvidence,
    ): boolean | Promise<boolean>;
    validateOutcome?(outcome: ActionEffectOutcome): void;
    /** Registered owner schema rejects secret-bearing effect outcomes. */
    action?: AnyActionDefinition;
    authorize?(transaction: SqlExecutor): Promise<void>;
  }>,
): ActionEffectClient {
  const { namespace, actionRunId, schema } = options;
  text(namespace);
  text(actionRunId);
  const tables = createCoreTableNames(schema);
  const outputSchema = options.action?.outputSchema &&
    snapshotActionSchema(options.action.outputSchema);
  const run = createSchemaCommandRunner(options.session, schema);
  const authorize = async (context: CommandContext) => {
    options.signal?.throwIfAborted();
    await options.authorize?.(context.transaction);
    if (options.writer) {
      const rows = await context.transaction.query(
        `SELECT 1 FROM ${tables.event_deliveries} AS delivery JOIN ${tables.open_actions} AS action
         ON action.owner_delivery_id=delivery.id WHERE delivery.id=$1 AND delivery.lease_owner=$2
         AND delivery.status='leased' AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at > $3::timestamptz)
         AND delivery.owner_epoch=$4 AND action.namespace=$5 AND action.action_run_id=$6
         AND ($7::text IS NULL OR action.action_id=$7)`,
        [
          options.writer.deliveryId,
          options.writer.leaseOwner,
          context.commandTime,
          context.caller.epoch,
          namespace,
          actionRunId,
          options.action?.id ?? null,
        ],
      );
      if (!rows.rows.length) {
        fail(
          "ActionOwnershipLost",
          "Effect belongs to an inactive Action attempt.",
        );
      }
    }
  };
  const read = async (tx: SqlExecutor, step: string) =>
    (await tx.query<EffectRow>(
      `SELECT step,status,outcome,evidence FROM ${tables.action_effects} WHERE namespace=$1 AND action_run_id=$2 AND step=$3`,
      [namespace, actionRunId, step],
    )).rows[0];
  const execute = <T>(
    operation: string,
    step: string,
    active: { signal?: AbortSignal } | undefined,
    callback: (tx: SqlExecutor, ref: EffectReference) => Promise<T>,
  ) => {
    text(step);
    active?.signal?.throwIfAborted();
    return run(
      `effect.${operation}`,
      { namespace, actionRunId, step },
      async (ref, context) => {
        await authorize(context);
        active?.signal?.throwIfAborted();
        const result = await callback(context.transaction, ref);
        options.signal?.throwIfAborted();
        active?.signal?.throwIfAborted();
        return result;
      },
    );
  };
  const receipt = async (
    tx: SqlExecutor,
    ref: EffectReference,
    operation: string,
    extra: object,
    result: object,
    mutation: string,
    values: readonly unknown[],
  ) => {
    await tx.query(
      `WITH effect_mutation AS (${mutation} RETURNING step)
       INSERT INTO ${tables.owner_receipts} (owner,domain,key,principal,kind,intent,result)
       SELECT 'schema','logical',$1,'runtime',$2,$3::jsonb,$4::jsonb FROM effect_mutation`,
      [
        effectKey(ref, operation),
        `effect.${operation}`,
        JSON.stringify({ ...ref, ...extra }),
        JSON.stringify({ ...ref, ...result }),
        ...values,
      ],
    );
  };
  return {
    begin: (step, active) =>
      execute("begin", step, active, async (tx, ref) => {
        const current = await read(tx, step);
        if (current) {
          return state(current) as Exclude<
            ActionEffectState,
            { status: "none" }
          >;
        }
        // The receipt records begun, never a reusable dispatch permission.
        await receipt(
          tx,
          ref,
          "begin",
          {},
          { status: "begun" },
          `INSERT INTO ${tables.action_effects} (namespace,action_run_id,step,status) VALUES ($5,$6,$7,'begun')`,
          [namespace, actionRunId, step],
        );
        return { status: "proceed" } as const;
      }),
    inspect: (step, active) =>
      execute(
        "inspect",
        step,
        active,
        async (tx) => state(await read(tx, step)),
      ),
    confirm: bindCapturedConfirmation((step, outcome, active) => {
      validateEffectData(outcome);
      options.validateOutcome?.(outcome);
      if (
        outputSchema &&
        splitSecretActionValue(outputSchema, outcome)
          .secret
      ) {
        fail(
          "effect_outcome_invalid",
          "Protected effect outcomes must use safe references.",
        );
      }
      return execute("confirm", step, active, async (tx, ref) => {
        const current = await read(tx, step);
        if (
          current?.status === "confirmed" &&
          sameActionValue(current.outcome, outcome)
        ) return;
        if (current?.status !== "begun") {
          fail(
            "effect_transition_conflict",
            "Only a begun effect can be confirmed with this outcome.",
          );
        }
        await receipt(
          tx,
          ref,
          "confirm",
          { outcome },
          {
            status: "confirmed",
            outcome,
          },
          `UPDATE ${tables.action_effects} SET status='confirmed',outcome=$8::jsonb WHERE namespace=$5 AND action_run_id=$6 AND step=$7`,
          [namespace, actionRunId, step, JSON.stringify(outcome)],
        );
      });
    }),
    notStarted: (step, value, active) => {
      const proof = evidence(value);
      return execute("notStarted", step, active, async (tx, ref) => {
        if (await options.verifyNotStarted?.(tx, ref, proof) !== true) {
          fail(
            "effect_evidence_refused",
            "No owner-verified no-start evidence.",
          );
        }
        const current = await read(tx, step);
        if (
          current?.status === "not_started" &&
          sameActionValue(current.evidence, proof)
        ) return;
        if (current?.status !== "begun") {
          fail(
            "effect_transition_conflict",
            "Only a begun effect can be closed as not started.",
          );
        }
        await receipt(
          tx,
          ref,
          "notStarted",
          { evidence: proof },
          { status: "not_started" },
          `UPDATE ${tables.action_effects} SET status='not_started',evidence=$8::jsonb WHERE namespace=$5 AND action_run_id=$6 AND step=$7`,
          [namespace, actionRunId, step, JSON.stringify(proof)],
        );
      });
    },
    inventory: (active) =>
      run(
        "effect.inventory",
        { namespace, actionRunId },
        async (_ref, context) => {
          await authorize(context);
          active?.signal?.throwIfAborted();
          return await readActionEffectInventory(context.transaction, {
            schema,
            namespace,
            actionRunId,
          });
        },
      ),
  };
}
