/** Narrow owner control metadata. Business lifecycle stays in deliveries/actions;
 * a durable reservation alone never proves Started or an external effect. */
import {
  createCoreTableNames,
  quoteEventIdentifier,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandHandler,
  OwnerJson,
} from "./boundary.ts";

export type OwnerAssignmentBinding = Readonly<{
  workerId: string;
  workerAttemptId: string;
  sessionGeneration: number;
  sessionId: string;
  parentOperationId: string;
  assignmentId: string;
  dispatchAttemptId: string;
  namespace: string;
  actionId: string;
  executionId: string;
  sourceEventId: string;
  deliveryId: string;
}>;
const fields = [
  "workerId",
  "workerAttemptId",
  "sessionGeneration",
  "sessionId",
  "parentOperationId",
  "assignmentId",
  "dispatchAttemptId",
  "namespace",
  "actionId",
  "executionId",
  "sourceEventId",
  "deliveryId",
] as const;
function binding(value: OwnerJson): OwnerAssignmentBinding {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("Invalid owner assignment binding.");
  }
  const input = value as Record<string, OwnerJson>;
  for (const key of fields) {
    const item = input[key];
    if (key === "sessionGeneration") {
      if (!Number.isSafeInteger(item) || Number(item) < 0) {
        throw new TypeError("Invalid session generation.");
      }
    } else if (
      typeof item !== "string" || !item.trim() || item !== item.trim() ||
      item.length > 1024
    ) {
      throw new TypeError("Invalid assignment identifier.");
    }
  }
  return { ...input } as OwnerAssignmentBinding;
}
function table(schema: string) {
  return `${quoteEventIdentifier(schema)}."owner_assignments"`;
}
export function ownerAssignmentKey(
  ownerId: string,
  value: Pick<OwnerAssignmentBinding, "sessionId" | "assignmentId">,
): string {
  return JSON.stringify([
    "assignment",
    ownerId,
    value.sessionId,
    value.assignmentId,
  ]);
}
/** Explicit fresh-schema provisioning; no production-data migration. */
export async function provisionOwnerAssignments(
  session: SqlSession,
  schema: string,
): Promise<void> {
  const tables = createCoreTableNames(schema);
  await session.transaction(async (tx) => {
    const existing = await tx.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='owner_assignments'",
      [schema],
    );
    if (existing.rows.length) {
      await validateOwnerAssignments(tx, schema);
      return;
    }
    await tx.query(`CREATE TABLE IF NOT EXISTS ${table(schema)} (
      owner TEXT NOT NULL REFERENCES ${
      quoteEventIdentifier(schema)
    }.owner_epochs(owner),
      epoch BIGINT NOT NULL CHECK(epoch>0), session_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL, delivery_id TEXT NOT NULL REFERENCES ${tables.event_deliveries}(id),
      binding JSONB NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL, retired_at TIMESTAMPTZ,
      PRIMARY KEY(owner,session_id,assignment_id))`);
    await tx.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS owner_assignments_live_delivery_idx
      ON ${table(schema)}(owner,delivery_id) WHERE retired=FALSE`,
    );
    await validateOwnerAssignments(tx, schema);
  });
}
export async function validateOwnerAssignments(
  tx: SqlExecutor,
  schema: string,
): Promise<void> {
  const columns = await tx.query<
    {
      column_name: string;
      is_nullable: string;
      data_type: string;
      column_default: string | null;
    }
  >(
    `SELECT column_name,is_nullable,data_type,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='owner_assignments'`,
    [schema],
  );
  const actual = new Map(columns.rows.map((row) => [row.column_name, row]));
  const expectedTypes: Record<string, string> = {
    owner: "text",
    epoch: "bigint",
    session_id: "text",
    assignment_id: "text",
    delivery_id: "text",
    binding: "jsonb",
    retired: "boolean",
    created_at: "timestamp with time zone",
    retired_at: "timestamp with time zone",
  };
  const validColumns = Object.entries(expectedTypes).every(([name, type]) => {
    const column = actual.get(name);
    return column?.data_type === type &&
      column.is_nullable === (name === "retired_at" ? "YES" : "NO");
  }) && actual.get("retired")?.column_default === "false";
  const required = [
    "owner",
    "epoch",
    "session_id",
    "assignment_id",
    "delivery_id",
    "binding",
    "retired",
    "created_at",
    "retired_at",
  ];
  const indexes = await tx.query<
    { primary: boolean; columns: string[]; predicate: string | null }
  >(
    `SELECT i.indisprimary AS primary,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relname='owner_assignments' AND i.indisunique AND i.indisvalid`,
    [schema],
  );
  const primary = indexes.rows.some((row) =>
    row.primary && row.predicate === null &&
    JSON.stringify(row.columns) ===
      JSON.stringify(["owner", "session_id", "assignment_id"])
  );
  const live = indexes.rows.some((row) =>
    !row.primary &&
    JSON.stringify(row.columns) === JSON.stringify(["owner", "delivery_id"]) &&
    /^(?:\(?retired = false\)?|\(?NOT retired\)?)$/.test(row.predicate ?? "")
  );
  const foreign = await tx.query<
    {
      columns: string[];
      target: string;
      target_schema: string;
      target_columns: string[];
    }
  >(
    `SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      target.relname AS target, targetns.nspname AS target_schema,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS target_columns
     FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class source ON source.oid=c.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid=source.relnamespace
     JOIN pg_catalog.pg_class target ON target.oid=c.confrelid
     JOIN pg_catalog.pg_namespace targetns ON targetns.oid=target.relnamespace
     WHERE ns.nspname=$1 AND source.relname='owner_assignments' AND c.contype='f'
       AND c.convalidated AND NOT c.condeferrable AND c.confdeltype='a' AND c.confupdtype='a'`,
    [schema],
  );
  const hasReference = (column: string, target: string, key: string) =>
    foreign.rows.some((row) =>
      row.target_schema === schema && row.target === target &&
      JSON.stringify(row.columns) === JSON.stringify([column]) &&
      JSON.stringify(row.target_columns) === JSON.stringify([key])
    );
  const checks = await tx.query<{ expression: string }>(
    `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS expression FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class t ON t.oid=c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
     WHERE n.nspname=$1 AND t.relname='owner_assignments' AND c.contype='c' AND c.convalidated`,
    [schema],
  );
  const positiveEpoch = checks.rows.some((row) =>
    row.expression.replace(/[\s()]/g, "") === "CHECKepoch>0"
  );
  if (
    !validColumns || !positiveEpoch ||
    required.some((name) => !actual.has(name)) || !primary || !live ||
    !hasReference("owner", "owner_epochs", "owner") ||
    !hasReference("delivery_id", "event_deliveries", "id")
  ) {
    throw new TypeError(
      "Owner assignment schema is incompatible; fresh provisioning is required.",
    );
  }
}
export function createOwnerAssignmentControl(
  options: Readonly<{
    ownerId: string;
    schema: string;
    maxActive?: number;
    /** Private host control authority, never worker-supplied command metadata. */
    authorizeControl(
      tx: SqlExecutor,
      caller: OwnerCaller,
      commandTime: string,
    ): void | Promise<void>;
    /** Synchronous fresh transport lookup, called inside each owner transaction.
     * Must verify the exact current session and Started parent assignment. */
    isCurrentStarted(caller: OwnerCaller): boolean;
  }>,
) {
  const name = table(options.schema);
  const tables = createCoreTableNames(options.schema);
  const maxActive = options.maxActive ?? 128;
  if (
    !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 100_000
  ) {
    throw new TypeError("Assignment reservation capacity is invalid.");
  }
  function validate(command: OwnerCommand): OwnerAssignmentBinding {
    const value = binding(command.intent);
    if (
      !["assignment.bind", "assignment.retire"].includes(command.kind) ||
      command.domain !== "incarnation" || command.key !==
        `${ownerAssignmentKey(options.ownerId, value)}:${command.kind}`
    ) {
      throw new TypeError("Assignment command identity is invalid.");
    }
    return value;
  }
  async function authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    time: string,
  ) {
    validate(command);
    await options.authorizeControl(tx, caller, time);
  }
  const bind: OwnerCommandHandler = async (input, context) => {
    const value = binding(input);
    const current = await context.tx.query<
      {
        binding: OwnerAssignmentBinding;
        epoch: string | number;
        retired: boolean;
      }
    >(
      `SELECT binding,epoch,retired FROM ${name} WHERE owner=$1 AND session_id=$2 AND assignment_id=$3 FOR UPDATE`,
      [options.ownerId, value.sessionId, value.assignmentId],
    );
    if (current.rows.length) {
      throw new Error("Assignment identity is already reserved.");
    }
    const eligible = await context.tx.query(
      `SELECT d.id FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
       WHERE d.id=$1 AND d.event_id=$2 AND e.namespace=$3
         AND e.metadata->>'actionId'=$4 AND e.metadata->>'actionRunId'=$5
         AND d.status IN ('pending','retry_wait') AND d.available_at <= $6::timestamptz
         AND d.attempts < d.max_attempts AND d.consumer_id=$7 FOR UPDATE OF d`,
      [
        value.deliveryId,
        value.sourceEventId,
        value.namespace,
        value.actionId,
        value.executionId,
        context.commandTime,
        `registered:${value.actionId}`,
      ],
    );
    if (!eligible.rows.length) {
      throw new Error("Delivery is not eligible for assignment.");
    }
    const count = await context.tx.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${name} WHERE owner=$1 AND retired=FALSE`,
      [options.ownerId],
    );
    if (Number(count.rows[0].count) >= maxActive) {
      throw new Error("Owner assignment capacity exceeded.");
    }
    await context.tx.query(
      `INSERT INTO ${name}
      (owner,epoch,session_id,assignment_id,delivery_id,binding,created_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
      [
        options.ownerId,
        context.ownerCommit.epoch,
        value.sessionId,
        value.assignmentId,
        value.deliveryId,
        JSON.stringify(value),
        context.commandTime,
      ],
    );
    return {
      assignmentId: value.assignmentId,
      sessionId: value.sessionId,
      deliveryId: value.deliveryId,
    };
  };
  const retire: OwnerCommandHandler = async (input, context) => {
    const value = binding(input);
    const result = await context.tx.query(
      `UPDATE ${name} SET retired=TRUE,retired_at=$1::timestamptz
      WHERE owner=$2 AND epoch<=$3 AND session_id=$4 AND assignment_id=$5 AND binding=$6::jsonb RETURNING assignment_id`,
      [
        context.commandTime,
        options.ownerId,
        context.ownerCommit.epoch,
        value.sessionId,
        value.assignmentId,
        JSON.stringify(value),
      ],
    );
    if (!result.rows.length) {
      throw new Error("Current assignment does not match retirement.");
    }
    return {
      assignmentId: value.assignmentId,
      sessionId: value.sessionId,
      retired: true,
    };
  };
  async function resolveStarted(
    tx: SqlExecutor,
    caller: OwnerCaller,
  ): Promise<OwnerAssignmentBinding | undefined> {
    const identity = { ...caller };
    if (!options.isCurrentStarted({ ...identity })) return undefined;
    const result = await tx.query<{ binding: OwnerAssignmentBinding }>(
      `SELECT binding FROM ${name} WHERE owner=$1 AND epoch=$2 AND session_id=$3
       AND assignment_id=$4 AND retired=FALSE FOR SHARE`,
      [
        options.ownerId,
        identity.ownerEpoch,
        identity.sessionId,
        identity.assignmentId,
      ],
    );
    const value = result.rows[0]?.binding;
    if (!value || !options.isCurrentStarted({ ...identity })) return undefined;
    for (
      const key of [
        "workerId",
        "workerAttemptId",
        "sessionGeneration",
        "sessionId",
        "parentOperationId",
        "assignmentId",
      ] as const
    ) {
      if (value[key] !== identity[key]) return undefined;
    }
    return { ...value };
  }
  return {
    handlers: { "assignment.bind": bind, "assignment.retire": retire },
    authorize,
    resolveStarted,
  };
}
