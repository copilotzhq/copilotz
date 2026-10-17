/** Private F5 effect state on the owner's existing immutable logical receipts.
 * Provider dispatch, Action authoring and automatic recovery remain composition
 * work. The client translates only a fresh known-committed acknowledgement into
 * a one-time proceed result; no stored receipt contains send permission. */
import type { SqlExecutor } from "../events/session.ts";
import { ownerTableNames } from "./schema.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandHandler,
  OwnerJson,
  OwnerProjectionHandler,
} from "./boundary.ts";
import {
  copy,
  fail,
  intent,
  OWNER_EFFECT_STEP_LIMIT,
  type OwnerEffectEvidence,
  ownerEffectKey,
  type OwnerEffectOperation,
  type OwnerEffectRecord,
  type OwnerEffectReference,
  type OwnerEffectStateReference,
  record,
  sameReference,
  text,
} from "./effects-client.ts";

type EffectRow = {
  key: string;
  kind: string;
  domain: string;
  intent: OwnerJson;
  result: OwnerJson;
  outcomes_equal: boolean;
};
function storedState(
  ownerId: string,
  ref: OwnerEffectReference,
  rows: readonly EffectRow[],
): OwnerEffectRecord {
  const operations = ["begin", "confirm", "notStarted"] as const;
  const keys = operations.map((op) => ownerEffectKey(ownerId, ref, op));
  const records = new Map<OwnerEffectOperation, OwnerEffectRecord>();
  for (const row of rows) {
    const op = operations[keys.indexOf(row.key)];
    if (
      !op || row.domain !== "logical" || row.kind !== `effect.${op}` ||
      records.has(op)
    ) {
      fail("effect_state_invalid", "Invalid stored effect identity.");
    }
    sameReference(intent(row.intent, op).ref, ref);
    const value = record(row.result, ref);
    if (
      value.status !==
        (op === "begin"
          ? "begun"
          : op === "confirm"
          ? "confirmed"
          : "not_started") ||
      (op === "confirm" && row.outcomes_equal !== true)
    ) {
      fail("effect_state_invalid", "Invalid stored effect transition.");
    }
    records.set(op, value);
  }
  if (
    (records.has("confirm") && records.has("notStarted")) ||
    (records.size > 0 && !records.has("begin"))
  ) {
    fail("effect_state_invalid", "Contradictory effect receipts.");
  }
  return records.get("confirm") ?? records.get("notStarted") ??
    records.get("begin") ?? { ...ref, status: "none" };
}

/** Internal owner-only SQL inventory. Call inside the fenced command/snapshot,
 * after host authorization. It returns no outcomes or reusable permissions.
 * The row cap bounds returned data, not the scan: indexed query-plan/scale proof
 * is still required before large owner receipt histories are production-ready. */
export async function readOwnerEffectInventory(
  tx: SqlExecutor,
  scope: Readonly<{
    ownerId: string;
    schema: string;
    namespace: string;
    actionRunId: string;
  }>,
): Promise<readonly OwnerEffectStateReference[]> {
  for (const value of [scope.ownerId, scope.namespace, scope.actionRunId]) {
    text(value);
  }
  const prefix = JSON.stringify([
    "effect",
    scope.ownerId,
    scope.namespace,
    scope.actionRunId,
  ]).slice(0, -1) + ",";
  const tables = ownerTableNames(scope.schema);
  const selected = await tx.query<
    EffectRow & { intent_has_outcome: boolean; result_has_outcome: boolean }
  >(
    `SELECT key,kind,domain,intent-'outcome' AS intent,result-'outcome' AS result,
      intent ? 'outcome' AS intent_has_outcome,result ? 'outcome' AS result_has_outcome,
      (intent->'outcome') IS NOT DISTINCT FROM (result->'outcome') AS outcomes_equal
     FROM ${tables.receipts} WHERE owner=$1 AND left(key,length($2))=$2
     ORDER BY key,domain LIMIT $3`,
    [scope.ownerId, prefix, OWNER_EFFECT_STEP_LIMIT * 3 + 1],
  );
  if (selected.rows.length > OWNER_EFFECT_STEP_LIMIT * 3) {
    fail("effect_step_limit", "Effect inventory exceeds its bound.");
  }
  const groups = new Map<string, EffectRow[]>();
  for (const row of selected.rows) {
    let key: unknown;
    try {
      key = JSON.parse(row.key);
    } catch {
      fail("effect_state_invalid", "Malformed effect receipt key.");
    }
    if (
      !Array.isArray(key) || key.length !== 6 || key[0] !== "effect" ||
      key[1] !== scope.ownerId ||
      key[2] !== scope.namespace || key[3] !== scope.actionRunId ||
      typeof key[4] !== "string" ||
      !["begin", "confirm", "notStarted"].includes(key[5])
    ) fail("effect_state_invalid", "Malformed effect receipt key.");
    const ref = {
      namespace: scope.namespace,
      actionRunId: scope.actionRunId,
      step: key[4],
    };
    const operation = key[5] as OwnerEffectOperation;
    if (row.key !== ownerEffectKey(scope.ownerId, ref, operation)) {
      fail("effect_state_invalid", "Noncanonical effect receipt key.");
    }
    const confirmed = operation === "confirm";
    if (
      row.intent_has_outcome !== confirmed ||
      row.result_has_outcome !== confirmed ||
      (confirmed && row.outcomes_equal !== true)
    ) {
      fail("effect_state_invalid", "Malformed stored effect outcome.");
    }
    const header = copy(row.intent);
    const result = copy(row.result);
    if (
      !header || typeof header !== "object" || Array.isArray(header) ||
      !result || typeof result !== "object" || Array.isArray(result)
    ) {
      fail("effect_state_invalid", "Malformed stored effect header.");
    }
    const group = groups.get(ref.step) ?? [];
    group.push({
      ...row,
      intent: { ...header, ...(confirmed ? { outcome: null } : {}) },
      result: { ...result, ...(confirmed ? { outcome: null } : {}) },
    });
    groups.set(ref.step, group);
    if (groups.size > OWNER_EFFECT_STEP_LIMIT) {
      fail("effect_step_limit", "Effect inventory exceeds its bound.");
    }
  }
  return [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(
    ([step, rows]) => {
      const state = storedState(scope.ownerId, {
        namespace: scope.namespace,
        actionRunId: scope.actionRunId,
        step,
      }, rows);
      if (state.status === "none") {
        fail("effect_state_invalid", "Missing inventoried effect.");
      }
      return { step, status: state.status };
    },
  );
}

export function createOwnerEffectCommands(
  options: Readonly<{
    ownerId: string;
    schema: string;
    /** Mandatory, SQL-only current host authority. Bind invocation to the exact
     * authenticated assignment/session/attempt and live lease (or local attempt).
     * Begin needs current ctx/effect grants; settlement must remain narrowly
     * available for started work after ctx revocation, never for a stale attempt.
     * Return true explicitly; payload reference fields grant no authority. */
    authorizeEffect(
      tx: SqlExecutor,
      caller: OwnerCaller,
      ref: OwnerEffectReference,
      mode: "begin" | "settlement",
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** Validate the registered outcome schema and safe durable representation.
     * Protected plaintext must be sealed/replaced by references outside this API.
     * Do not perform external I/O in any of these transaction callbacks. */
    validateOutcome(
      tx: SqlExecutor,
      caller: OwnerCaller,
      ref: OwnerEffectReference,
      outcome: OwnerJson,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** Verify the exact effect/dispatch/attempt against host-owned evidence. */
    verifyNotStarted(
      tx: SqlExecutor,
      caller: OwnerCaller,
      ref: OwnerEffectReference,
      evidence: OwnerEffectEvidence,
      commandTime: string,
    ): boolean | Promise<boolean>;
  }>,
): Readonly<{
  handlers: Readonly<Record<string, OwnerCommandHandler>>;
  projections: Readonly<Record<string, OwnerProjectionHandler>>;
  authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    commandTime: string,
  ): Promise<void>;
}> {
  text(options.ownerId);
  for (
    const key of [
      "authorizeEffect",
      "validateOutcome",
      "verifyNotStarted",
    ] as const
  ) {
    if (typeof options[key] !== "function") {
      fail("effect_configuration_invalid", `${key} is required.`);
    }
  }
  const tables = ownerTableNames(options.schema);
  const authorized = new WeakMap<
    SqlExecutor,
    Readonly<{ ref: OwnerEffectReference; kind: string }>
  >();
  async function read(
    tx: SqlExecutor,
    ref: OwnerEffectReference,
  ): Promise<OwnerEffectRecord> {
    const operations = ["begin", "confirm", "notStarted"] as const;
    const keys = operations.map((op) =>
      ownerEffectKey(options.ownerId, ref, op)
    );
    const rows = await tx.query<
      EffectRow
    >(
      `SELECT key,kind,domain,intent,result,(intent->'outcome') IS NOT DISTINCT FROM (result->'outcome') AS outcomes_equal FROM ${tables.receipts} WHERE owner=$1 AND domain='logical' AND key=ANY($2::text[])`,
      [options.ownerId, keys],
    );
    return storedState(options.ownerId, ref, rows.rows);
  }

  function bound(tx: SqlExecutor, kind: string): OwnerEffectReference {
    const current = authorized.get(tx);
    if (!current || current.kind !== kind) {
      fail(
        "effect_authority_refused",
        "Effect handler requires current boundary authorization.",
      );
    }
    return current.ref;
  }
  const handlers: Readonly<Record<string, OwnerCommandHandler>> = {
    "effect.begin": async (_input, context) => {
      const ref = bound(context.tx, "effect.begin");
      if ((await read(context.tx, ref)).status !== "none") {
        fail("effect_transition_conflict", "Effect already began.");
      }
      return { ...ref, status: "begun" };
    },
    "effect.confirm": async (input, context) => {
      const ref = bound(context.tx, "effect.confirm");
      if ((await read(context.tx, ref)).status !== "begun") {
        fail(
          "effect_transition_conflict",
          "Only a begun effect can be confirmed.",
        );
      }
      return {
        ...ref,
        status: "confirmed",
        outcome: intent(input, "confirm").outcome!,
      };
    },
    "effect.notStarted": async (_input, context) => {
      const ref = bound(context.tx, "effect.notStarted");
      if ((await read(context.tx, ref)).status !== "begun") {
        fail(
          "effect_transition_conflict",
          "Only a begun effect can be closed as not started.",
        );
      }
      return { ...ref, status: "not_started" };
    },
  };
  return {
    handlers,
    projections: {
      "effect.state": async (_input, context) =>
        await read(context.tx, bound(context.tx, "effect.state")),
    },
    async authorize(tx, caller, command, commandTime) {
      const op = command.kind.slice("effect.".length) as OwnerEffectOperation;
      const projection = command.kind === "effect.state";
      if (
        (!projection && !Object.hasOwn(handlers, command.kind)) ||
        (projection
          ? command.domain !== "occurrence"
          : command.domain !== "logical")
      ) fail("effect_data_invalid", "Unknown effect command.");
      const data = intent(command.intent, projection ? undefined : op);
      if (
        !projection &&
        command.key !== ownerEffectKey(options.ownerId, data.ref, op)
      ) {
        fail(
          "effect_binding_invalid",
          "Effect key does not match its invocation and step.",
        );
      }
      if (
        await options.authorizeEffect(
          tx,
          caller,
          copy(data.ref),
          op === "begin" ? "begin" : "settlement",
          commandTime,
        ) !== true
      ) fail("effect_authority_refused", "Current effect authority refused.");
      if (
        op === "confirm" &&
        await options.validateOutcome(
            tx,
            caller,
            copy(data.ref),
            copy(data.outcome!),
            commandTime,
          ) !== true
      ) {
        fail(
          "effect_outcome_invalid",
          "Effect outcome is not a registered safe representation.",
        );
      }
      if (
        op === "notStarted" &&
        await options.verifyNotStarted(
            tx,
            caller,
            copy(data.ref),
            copy(data.evidence!),
            commandTime,
          ) !== true
      ) fail("effect_evidence_refused", "No owner-verified no-start evidence.");
      // Inspect all fixed receipts before duplicate replay too. A historical
      // acknowledgement cannot skip a contradictory or closed transition.
      const current = await read(tx, data.ref);
      if (op === "begin" && current.status === "none") {
        const inventory = await readOwnerEffectInventory(tx, {
          ownerId: options.ownerId,
          schema: options.schema,
          ...data.ref,
        });
        if (inventory.length >= OWNER_EFFECT_STEP_LIMIT) {
          fail(
            "effect_step_limit",
            "Effect invocation reached its step bound.",
          );
        }
      }
      if (
        (op === "confirm" && current.status !== "begun" &&
          current.status !== "confirmed") ||
        (op === "notStarted" && current.status !== "begun" &&
          current.status !== "not_started")
      ) {
        fail(
          "effect_transition_conflict",
          "Effect transition is no longer legal.",
        );
      }
      authorized.set(tx, { ref: data.ref, kind: command.kind });
    },
  };
}
