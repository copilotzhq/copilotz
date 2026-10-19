/** The sole owner-fenced durable external-effect state machine. */
import {
  type CommandContext,
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { sameActionValue } from "./value.ts";
import { snapshotActionSchema, splitSecretActionValue } from "./secret.ts";
import type {
  ActionEffectEvidence,
  ActionEffectOutcome,
  ActionEffectState,
} from "./types.ts";
import {
  type ActionEffectClient,
  assertPlainEffectOutcome,
  copy,
  EFFECT_STEP_LIMIT,
  type EffectInventoryEntry,
  effectKey,
  type EffectReference,
  evidence,
  fail,
  PROTECTED_EFFECT_OUTPUT_SCHEMA,
  text,
} from "./effect-client.ts";

import {
  type ActionOutputBinding,
  actionOutputKey,
  adoptCapturedActionOutput,
  assertCapturedActionOutput,
  captureActionOutput,
  openCapturedActionOutput,
  prepareCapturedActionOutput,
  type ProtectedEffectOutput,
  readCapturedActionOutput,
} from "./protected-effect-output.ts";

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
/** Complete bounded inventory: one extra row detects overflow, never truncates. */
export async function readActionEffectInventory(
  transaction: SqlExecutor,
  scope: { schema: string; namespace: string; actionRunId: string },
): Promise<readonly EffectInventoryEntry[]> {
  text(scope.namespace);
  text(scope.actionRunId);
  const table = createCoreTableNames(scope.schema).action_effects;
  const rows = (await transaction.query<EffectInventoryEntry>(
    `SELECT step,status,CASE WHEN action_run_id<>$2 THEN action_run_id END AS "actionRunId"
     FROM ${table} WHERE namespace=$1 AND (action_run_id=$2 OR (status='begun' AND ancestors @> $4::jsonb))
     ORDER BY action_run_id,step LIMIT $3`,
    [
      scope.namespace,
      scope.actionRunId,
      EFFECT_STEP_LIMIT + 1,
      JSON.stringify([scope.actionRunId]),
    ],
  )).rows;
  if (rows.length > EFFECT_STEP_LIMIT) {
    fail("effect_step_limit", "Effect inventory exceeds its bound.");
  }
  for (const row of rows) {
    text(row.step);
    if (!["begun", "confirmed", "not_started"].includes(row.status)) {
      fail("effect_state_invalid", "Invalid retained effect state.");
    }
  }
  return rows.map(({ step, status, actionRunId }) => ({
    step,
    status,
    ...(actionRunId ? { actionRunId } : {}),
  }));
}

export function createOwnerEffectClient(
  options: Readonly<{
    session: SqlExecutor;
    schema: string;
    namespace: string;
    actionRunId: string;
    parentActionRunId?: string;
    writer?: Readonly<{ deliveryId: string; leaseOwner: string }>;
    signal?: AbortSignal;
    /** Trusted owner-only verifier; a worker's evidence assertion is never proof. */
    verifyNotStarted?(
      transaction: SqlExecutor,
      ref: EffectReference,
      proof: ActionEffectEvidence,
    ): boolean | Promise<boolean>;
    validateOutcome?(outcome: ActionEffectOutcome): void;
    /** Owner-bound registered Action output; never accepted from the worker. */
    output?: Omit<
      ActionOutputBinding,
      "databaseSchema" | "namespace" | "actionRunId"
    >;
    /** Same output-slot authority used by the normal completion path. */
    authorizeOutput?(context: CommandContext): void | Promise<void>;
  }>,
): ActionEffectClient {
  const { namespace, actionRunId, schema } = options;
  text(namespace);
  text(actionRunId);
  const tables = createCoreTableNames(schema);
  const outputBinding = options.output &&
    {
      ...options.output,
      action: {
        ...options.output.action,
        ...(options.output.action.outputSchema
          ? {
            outputSchema: snapshotActionSchema(
              options.output.action.outputSchema,
            ),
          }
          : {}),
      },
      databaseSchema: schema,
      namespace,
      actionRunId,
    };
  const requireOutput = () =>
    outputBinding ??
      fail(
        "effect_output_unavailable",
        "A bound protected Action output is required.",
      );
  const outputState = async (
    tx: SqlExecutor,
    row?: EffectRow,
  ): Promise<ActionEffectState> => {
    if (
      row?.status === "confirmed" && row.outcome &&
      typeof row.outcome === "object" && !Array.isArray(row.outcome) &&
      (row.outcome as Record<string, unknown>).schema ===
        PROTECTED_EFFECT_OUTPUT_SCHEMA
    ) {
      const binding = requireOutput();
      if (
        Object.keys(row.outcome).sort().join(",") !== "captureKey,schema" ||
        (row.outcome as Record<string, unknown>).captureKey !==
          actionOutputKey(binding)
      ) {
        fail(
          "effect_output_binding",
          "Retained effect output has a different binding.",
        );
      }
      await options.authorizeOutput?.(schemaCommandContext(tx, schema));
      const capture = await readCapturedActionOutput(tx, binding);
      if (!capture) {
        fail("effect_output_binding", "Retained Action output is missing.");
      }
      const outcome = await openCapturedActionOutput(binding, capture, tx);
      await options.authorizeOutput?.(schemaCommandContext(tx, schema));
      options.signal?.throwIfAborted();
      return { status: "replay", outcome };
    }
    return state(row);
  };
  const run = createSchemaCommandRunner(options.session, schema);
  const scopeKey = (runId: string) =>
    JSON.stringify(["effect-scope", namespace, runId]);
  const ancestry = async (tx: SqlExecutor): Promise<readonly string[]> => {
    const load = async (runId: string) =>
      (await tx.query<
        {
          intent: { parentActionRunId: string | null };
          result: { ancestors: string[] };
        }
      >(
        `SELECT intent,result FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND key=$1`,
        [scopeKey(runId)],
      )).rows[0];
    const prior = await load(actionRunId);
    if (prior) {
      if (
        prior.intent.parentActionRunId !== (options.parentActionRunId ?? null)
      ) {
        fail(
          "effect_scope_conflict",
          "Effect ancestry changed between attempts.",
        );
      }
      return prior.result.ancestors;
    }
    let ancestors: string[] = [];
    if (options.parentActionRunId) {
      const parent = await load(options.parentActionRunId);
      if (!parent) {
        fail(
          "effect_indeterminate",
          "Original parent effect scope is unavailable.",
        );
      }
      ancestors = [...parent.result.ancestors, options.parentActionRunId];
    }
    if (
      ancestors.length > EFFECT_STEP_LIMIT || ancestors.includes(actionRunId)
    ) {
      fail("effect_step_limit", "Effect ancestry exceeds its bound.");
    }
    await tx.query(
      `INSERT INTO ${tables.owner_receipts} (owner,domain,key,principal,kind,intent,result)
       VALUES ('schema','logical',$1,'runtime','effect.scope',$2::jsonb,$3::jsonb)`,
      [
        scopeKey(actionRunId),
        JSON.stringify({
          parentActionRunId: options.parentActionRunId ?? null,
        }),
        JSON.stringify({ ancestors }),
      ],
    );
    return ancestors;
  };
  const authorize = async (context: CommandContext) => {
    options.signal?.throwIfAborted();
    await outputBinding?.authorize?.(context.transaction);
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
          outputBinding?.action.id ?? null,
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
  ) => {
    await tx.query(
      `INSERT INTO ${tables.owner_receipts} (owner,domain,key,principal,kind,intent,result)
       VALUES ('schema','logical',$1,'runtime',$2,$3::jsonb,$4::jsonb)`,
      [
        effectKey(ref, operation),
        `effect.${operation}`,
        JSON.stringify({ ...ref, ...extra }),
        JSON.stringify({ ...ref, ...result }),
      ],
    );
  };
  return {
    begin: (step, active) =>
      execute("begin", step, active, async (tx, ref) => {
        const current = await read(tx, step);
        if (current) {
          return await outputState(tx, current) as Exclude<
            ActionEffectState,
            { status: "none" }
          >;
        }
        const inventory = await readActionEffectInventory(tx, {
          schema,
          namespace,
          actionRunId,
        });
        if (inventory.length >= EFFECT_STEP_LIMIT) {
          fail(
            "effect_step_limit",
            "An Action exceeded its effect step limit.",
          );
        }
        await tx.query(
          `INSERT INTO ${tables.action_effects} (namespace,action_run_id,step,status,ancestors) VALUES ($1,$2,$3,'begun',$4::jsonb)`,
          [namespace, actionRunId, step, JSON.stringify(await ancestry(tx))],
        );
        // The receipt records begun, never a reusable dispatch permission.
        await receipt(tx, ref, "begin", {}, { status: "begun" });
        return { status: "proceed" } as const;
      }),
    inspect: (step, active) =>
      execute(
        "inspect",
        step,
        active,
        async (tx) => await outputState(tx, await read(tx, step)),
      ),
    confirm: (step, value, active) => {
      const outcome = copy(value);
      assertPlainEffectOutcome(outcome);
      options.validateOutcome?.(outcome);
      if (
        outputBinding &&
        splitSecretActionValue(outputBinding.action.outputSchema, outcome)
          .secret
      ) {
        fail(
          "effect_outcome_invalid",
          "Protected outputs require confirmOutput.",
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
        await tx.query(
          `UPDATE ${tables.action_effects} SET status='confirmed',outcome=$4::jsonb WHERE namespace=$1 AND action_run_id=$2 AND step=$3`,
          [namespace, actionRunId, step, JSON.stringify(outcome)],
        );
        await receipt(tx, ref, "confirm", { outcome }, {
          status: "confirmed",
          outcome,
        });
      });
    },
    confirmOutput: (step, value, active) => {
      // Snapshot and full schema validation happen before asynchronous admission.
      const binding = requireOutput();
      const output = captureActionOutput(binding, value);
      const outcome: ProtectedEffectOutput = {
        schema: PROTECTED_EFFECT_OUTPUT_SCHEMA,
        captureKey: actionOutputKey(binding),
      } as const;
      const checkStep = (current?: EffectRow) => {
        if (
          current?.status === "confirmed" &&
          sameActionValue(current.outcome, outcome)
        ) return;
        if (current?.status !== "begun") {
          fail(
            "effect_transition_conflict",
            "Only a begun effect can capture this Action output.",
          );
        }
      };
      return (async () => {
        const existing = await execute(
          "inspectOutput",
          step,
          active,
          async (tx) => {
            await options.authorizeOutput?.(schemaCommandContext(tx, schema));
            checkStep(await read(tx, step));
            const capture = await readCapturedActionOutput(tx, binding);
            if (capture) {
              await assertCapturedActionOutput(
                binding,
                capture,
                output,
                tx,
              );
            }
            return capture;
          },
        );
        // A committed capture is checked before sealing. Staging is outside the
        // owner transaction; unused bytes remain unowned under catalog protection.
        const prepared = existing
          ? undefined
          : await prepareCapturedActionOutput(binding, output);
        await execute("confirmOutput", step, active, async (tx, ref) => {
          await options.authorizeOutput?.(schemaCommandContext(tx, schema));
          const current = await read(tx, step);
          checkStep(current);
          const accepted = prepared
            ? await adoptCapturedActionOutput(tx, binding, output, prepared)
            : await readCapturedActionOutput(tx, binding);
          if (!accepted) {
            fail("effect_output_binding", "Retained Action output is missing.");
          }
          if (existing && !sameActionValue(existing, accepted)) {
            fail("effect_output_binding", "Retained Action output changed.");
          }
          if (current?.status === "confirmed") {
            await options.authorizeOutput?.(schemaCommandContext(tx, schema));
            return;
          }
          await tx.query(
            `UPDATE ${tables.action_effects} SET status='confirmed',outcome=$4::jsonb WHERE namespace=$1 AND action_run_id=$2 AND step=$3`,
            [namespace, actionRunId, step, JSON.stringify(outcome)],
          );
          await receipt(tx, ref, "confirm", { outcome }, {
            status: "confirmed",
            outcome,
          });
          await options.authorizeOutput?.(schemaCommandContext(tx, schema));
        });
      })();
    },
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
        await tx.query(
          `UPDATE ${tables.action_effects} SET status='not_started',evidence=$4::jsonb WHERE namespace=$1 AND action_run_id=$2 AND step=$3`,
          [namespace, actionRunId, step, JSON.stringify(proof)],
        );
        await receipt(tx, ref, "notStarted", { evidence: proof }, {
          status: "not_started",
        });
      });
    },
    inventory: (active) =>
      run(
        "effect.inventory",
        { namespace, actionRunId },
        async (_ref, context) => {
          await authorize(context);
          await ancestry(context.transaction);
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
