/** Narrow owner control metadata. A reservation alone never proves current
 * execution authority, Started, readiness, or an external effect. */
import {
  createCoreTableNames,
  quoteEventIdentifier,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandContext,
  OwnerCommandHandler,
  OwnerJson,
} from "./boundary.ts";
import { ownerPrincipalIdentity } from "./principal.ts";

import {
  OWNER_ASSIGNMENT_BINDING_MAX_BYTES,
  type OwnerActionAssignmentBinding,
  type OwnerAssignmentBinding,
  type OwnerLocalActionAssignmentBinding,
  type OwnerLocalAssignmentBinding,
  type OwnerLocalProcessorAssignmentBinding,
  type OwnerPlacementBinding,
  type OwnerProcessorAssignmentBinding,
  parseOwnerPlacementBinding,
} from "./placement-binding.ts";
export {
  isOwnerProcessorAssignmentBinding,
  OWNER_ASSIGNMENT_BINDING_MAX_BYTES,
  type OwnerActionAssignmentBinding,
  type OwnerAssignmentBinding,
  type OwnerLocalActionAssignmentBinding,
  type OwnerLocalAssignmentBinding,
  type OwnerLocalProcessorAssignmentBinding,
  type OwnerPlacementBinding,
  type OwnerProcessorAssignmentBinding,
  parseOwnerPlacementBinding,
} from "./placement-binding.ts";
export type OwnerStoredAssignment = Readonly<{
  owner: string;
  epoch: number;
  key: string;
  binding: OwnerPlacementBinding;
  retired: boolean;
}>;
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError("Invalid assignment identifier.");
  }
}
/** Closed, exact and detached. Stored JSON and private callback facts use the
 * same decoder; missing tags, coercion and foreign placement fields fail closed. */
function assignmentRecord(value: unknown): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("Invalid owner assignment record.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Invalid owner assignment record property.");
    }
    entries.push([key as string, descriptor.value]);
  }
  return Object.fromEntries(entries);
}
function table(schema: string) {
  return `${quoteEventIdentifier(schema)}."owner_assignments"`;
}
type AssignmentKeyIdentity =
  | Pick<
    OwnerActionAssignmentBinding,
    "placement" | "sessionId" | "assignmentId"
  >
  | Pick<
    OwnerLocalActionAssignmentBinding,
    "placement" | "epoch" | "deliveryId" | "attemptId"
  >;
/** Versioned, tagged fixed-order tuples are unambiguous across placements. */
export function ownerAssignmentKey(
  ownerId: string,
  value: AssignmentKeyIdentity,
): string {
  identifier(ownerId);
  if (value.placement === "worker") {
    identifier(value.sessionId);
    identifier(value.assignmentId);
    return JSON.stringify([
      "owner-assignment",
      1,
      "worker",
      ownerId,
      value.sessionId,
      value.assignmentId,
    ]);
  }
  if (
    value.placement !== "owner-local" || !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1
  ) {
    throw new TypeError("Invalid assignment key placement or epoch.");
  }
  identifier(value.deliveryId);
  identifier(value.attemptId);
  return JSON.stringify([
    "owner-assignment",
    1,
    "owner-local",
    ownerId,
    value.epoch,
    value.deliveryId,
    value.attemptId,
  ]);
}
/** Decode a complete SQL row and reject inconsistent control coordinates. */
export function parseOwnerStoredAssignment(
  row: Readonly<Record<string, unknown>>,
): OwnerStoredAssignment {
  const input = assignmentRecord(row);
  identifier(input.owner);
  const epoch =
    typeof input.epoch === "string" && /^[1-9][0-9]*$/.test(input.epoch)
      ? Number(input.epoch)
      : input.epoch;
  if (
    !Number.isSafeInteger(epoch) || Number(epoch) < 1 ||
    typeof input.retired !== "boolean"
  ) {
    throw new TypeError("Invalid stored assignment epoch or retirement.");
  }
  const binding = parseOwnerPlacementBinding(input.binding);
  if (
    input.assignment_key !== ownerAssignmentKey(input.owner, binding) ||
    input.delivery_id !== binding.deliveryId ||
    (binding.placement === "owner-local" &&
      (binding.ownerId !== input.owner || binding.epoch !== epoch))
  ) {
    throw new TypeError(
      "Stored assignment coordinates do not match its binding.",
    );
  }
  return {
    owner: input.owner,
    epoch: epoch as number,
    key: input.assignment_key as string,
    binding,
    retired: input.retired,
  };
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
      epoch BIGINT NOT NULL CHECK(epoch>0), assignment_key TEXT NOT NULL,
      delivery_id TEXT NOT NULL REFERENCES ${tables.event_deliveries}(id),
      binding JSONB NOT NULL, retired BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL, retired_at TIMESTAMPTZ,
      PRIMARY KEY(owner,assignment_key))`);
    await tx.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS owner_assignments_live_delivery_idx
      ON ${table(schema)}(owner,delivery_id) WHERE retired=FALSE`,
    );
    await tx.query(
      `CREATE INDEX IF NOT EXISTS owner_assignments_delivery_history_idx ON ${
        table(schema)
      }(delivery_id,owner)`,
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
    assignment_key: "text",
    delivery_id: "text",
    binding: "jsonb",
    retired: "boolean",
    created_at: "timestamp with time zone",
    retired_at: "timestamp with time zone",
  };
  const validColumns = actual.size === Object.keys(expectedTypes).length &&
    Object.entries(expectedTypes).every(([name, type]) => {
      const column = actual.get(name);
      return column?.data_type === type &&
        column.is_nullable === (name === "retired_at" ? "YES" : "NO");
    }) && actual.get("retired")?.column_default === "false";
  const required = [
    "owner",
    "epoch",
    "assignment_key",
    "delivery_id",
    "binding",
    "retired",
    "created_at",
    "retired_at",
  ];
  const indexes = await tx.query<
    {
      primary: boolean;
      unique: boolean;
      method: string;
      key_count: number;
      attribute_count: number;
      simple: boolean;
      columns: string[];
      predicate: string | null;
    }
  >(
    `SELECT i.indisprimary AS primary,i.indisunique AS unique,am.amname AS method,
      i.indnkeyatts AS key_count,i.indnatts AS attribute_count,i.indexprs IS NULL AS simple,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.ord) AS columns,
      pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate
     FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=idx.relam
     WHERE n.nspname=$1 AND c.relname='owner_assignments' AND i.indisvalid AND i.indisready`,
    [schema],
  );
  const primary = indexes.rows.some((row) =>
    row.primary && row.unique && row.method === "btree" && row.simple &&
    row.key_count === 2 && row.attribute_count === 2 &&
    row.predicate === null &&
    JSON.stringify(row.columns) ===
      JSON.stringify(["owner", "assignment_key"])
  );
  const live = indexes.rows.some((row) =>
    !row.primary && row.unique && row.method === "btree" && row.simple &&
    row.key_count === 2 && row.attribute_count === 2 &&
    JSON.stringify(row.columns) === JSON.stringify(["owner", "delivery_id"]) &&
    /^(?:\(?retired = false\)?|\(?NOT retired\)?)$/.test(row.predicate ?? "")
  );
  // The live partial index cannot bound a lookup that includes retired history.
  const history = indexes.rows.some((row) =>
    !row.primary && !row.unique && row.method === "btree" && row.simple &&
    row.key_count === 2 && row.attribute_count === 2 &&
    row.predicate === null &&
    JSON.stringify(row.columns) === JSON.stringify(["delivery_id", "owner"])
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
    !history ||
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
    /** Private host control authority, never worker-supplied metadata. */
    authorizeControl(
      tx: SqlExecutor,
      caller: OwnerCaller,
      commandTime: string,
    ): void | Promise<void>;
    /** Fresh, synchronous transport lookup of exact current Started authority. */
    isCurrentStarted(caller: OwnerCaller): boolean;
    /** Host-private current handle lookup. A principal tag alone grants nothing.
     * The complete expected binding is checked before and after durable reads. */
    resolveCurrentLocal?(
      caller: OwnerCaller,
    ): OwnerLocalAssignmentBinding | undefined;
    hasAction?(actionId: string): boolean;
    hasProcessor?(processorId: string): boolean;
  }>,
) {
  const ownerId = options.ownerId;
  identifier(ownerId);
  const name = table(options.schema);
  const epochs = `${quoteEventIdentifier(options.schema)}."owner_epochs"`;
  const tables = createCoreTableNames(options.schema);
  const maxActive = options.maxActive ?? 128;
  const currentStarted = options.isCurrentStarted;
  const authorizeControl = options.authorizeControl;
  const hasAction = options.hasAction;
  const hasProcessor = options.hasProcessor;
  const currentLocal = options.resolveCurrentLocal;
  if (
    !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 100_000
  ) {
    throw new TypeError("Assignment reservation capacity is invalid.");
  }
  function validate(command: OwnerCommand): OwnerPlacementBinding {
    const value = parseOwnerPlacementBinding(command.intent);
    if (
      !["assignment.bind", "assignment.retire"].includes(command.kind) ||
      command.domain !== "incarnation" ||
      command.key !== `${ownerAssignmentKey(ownerId, value)}:${command.kind}`
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
    if (caller.principal.kind !== "owner-control") {
      throw new Error("Assignment control principal required.");
    }
    await authorizeControl(tx, {
      ...caller,
      principal: { ...caller.principal },
    }, time);
  }
  function isProcessor(
    value: OwnerPlacementBinding,
  ): value is
    | OwnerProcessorAssignmentBinding
    | OwnerLocalProcessorAssignmentBinding {
    return "kind" in value && value.kind === "processor";
  }
  const bind: OwnerCommandHandler = async (
    input,
    context,
  ): Promise<OwnerJson> => {
    const value = parseOwnerPlacementBinding(input);
    const key = ownerAssignmentKey(ownerId, value);
    if (
      value.placement === "owner-local" &&
      (value.ownerId !== ownerId || value.epoch !== context.ownerCommit.epoch ||
        value.holderId !== context.ownerCommit.holderId)
    ) {
      throw new Error(
        "Local assignment does not match current owner authority.",
      );
    }
    const current = await context.tx.query(
      `SELECT assignment_key FROM ${name} WHERE owner=$1 AND assignment_key=$2 FOR UPDATE`,
      [ownerId, key],
    );
    if (current.rows.length) {
      throw new Error("Assignment identity is already reserved.");
    }
    const processor = isProcessor(value);
    if (processor && hasProcessor?.(value.processorId) !== true) {
      throw new TypeError(
        "Registered Processor is unavailable for assignment.",
      );
    }
    if (
      value.placement === "owner-local" && value.kind === "action" &&
      hasAction?.(value.actionId) !== true
    ) {
      throw new TypeError(
        "Registered Action is unavailable for local assignment.",
      );
    }
    const eligible = processor
      ? await context.tx.query(
        `SELECT d.id FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
         WHERE d.id=$1 AND d.event_id=$2 AND e.namespace=$3
           AND d.status IN ('pending','retry_wait') AND d.available_at <= $4::timestamptz
           AND d.attempts < d.max_attempts AND d.consumer_id=$5 AND e.owner_id=$6 FOR UPDATE OF d`,
        [
          value.deliveryId,
          value.sourceEventId,
          value.namespace,
          context.commandTime,
          `processor:${value.processorId}`,
          ownerId,
        ],
      )
      : await context.tx.query(
        `SELECT d.id FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
         WHERE d.id=$1 AND d.event_id=$2 AND e.namespace=$3
           AND jsonb_typeof(e.metadata->'actionId')='string' AND jsonb_typeof(e.metadata->'actionRunId')='string'
           AND e.metadata->>'actionId'=$4 AND e.metadata->>'actionRunId'=$5
           AND d.status IN ('pending','retry_wait') AND d.available_at <= $6::timestamptz
           AND d.attempts < d.max_attempts AND d.consumer_id=$7 AND e.owner_id=$8 FOR UPDATE OF d`,
        [
          value.deliveryId,
          value.sourceEventId,
          value.namespace,
          value.actionId,
          value.placement === "worker" ? value.executionId : value.actionRunId,
          context.commandTime,
          `registered:${value.actionId}`,
          ownerId,
        ],
      );
    if (!eligible.rows.length) {
      throw new Error("Delivery is not eligible for assignment.");
    }
    const count = await context.tx.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${name} WHERE owner=$1 AND retired=FALSE`,
      [ownerId],
    );
    if (Number(count.rows[0].count) >= maxActive) {
      throw new Error("Owner assignment capacity exceeded.");
    }
    await context.tx.query(
      `INSERT INTO ${name} (owner,epoch,assignment_key,delivery_id,binding,created_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::timestamptz)`,
      [
        ownerId,
        context.ownerCommit.epoch,
        key,
        value.deliveryId,
        JSON.stringify(value),
        context.commandTime,
      ],
    );
    return value.placement === "worker"
      ? {
        assignmentId: value.assignmentId,
        sessionId: value.sessionId,
        deliveryId: value.deliveryId,
      }
      : {
        assignmentKey: key,
        attemptId: value.attemptId,
        deliveryId: value.deliveryId,
      };
  };
  const retire: OwnerCommandHandler = async (
    input,
    context,
  ): Promise<OwnerJson> => {
    const value = parseOwnerPlacementBinding(input);
    const key = ownerAssignmentKey(ownerId, value);
    const result = await context.tx.query(
      `UPDATE ${name} SET retired=TRUE,retired_at=$1::timestamptz
       WHERE owner=$2 AND epoch<=$3 AND assignment_key=$4 AND delivery_id=$5 AND binding=$6::jsonb AND retired=FALSE RETURNING assignment_key`,
      [
        context.commandTime,
        ownerId,
        context.ownerCommit.epoch,
        key,
        value.deliveryId,
        JSON.stringify(value),
      ],
    );
    if (!result.rows.length) {
      throw new Error("Current assignment does not match retirement.");
    }
    return value.placement === "worker"
      ? {
        assignmentId: value.assignmentId,
        sessionId: value.sessionId,
        retired: true,
      }
      : { assignmentKey: key, attemptId: value.attemptId, retired: true };
  };
  function matchesSource(
    row: Record<string, unknown>,
    value: OwnerPlacementBinding,
  ): boolean {
    if (
      row.source_owner !== ownerId ||
      row.source_event_id !== value.sourceEventId ||
      row.source_namespace !== value.namespace
    ) return false;
    if ("kind" in value && value.kind === "processor") {
      return row.source_consumer === `processor:${value.processorId}`;
    }
    return row.source_consumer === `registered:${value.actionId}` &&
      row.source_action_id === value.actionId &&
      row.source_action_run_id ===
        (value.placement === "worker" ? value.executionId : value.actionRunId);
  }
  async function resolveStarted(
    tx: SqlExecutor,
    caller: OwnerCaller,
  ): Promise<OwnerAssignmentBinding | undefined> {
    if (
      caller.principal.kind !== "worker" || Object.hasOwn(caller, "workerId")
    ) return undefined;
    const identity: OwnerCaller & { principal: typeof caller.principal } = {
      ...caller,
      principal: { ...caller.principal },
    };
    if (
      !currentStarted({ ...identity, principal: { ...identity.principal } })
    ) return undefined;
    let key: string;
    try {
      key = ownerAssignmentKey(ownerId, {
        placement: "worker",
        sessionId: identity.sessionId as string,
        assignmentId: identity.assignmentId as string,
      });
    } catch {
      return undefined;
    }
    const result = await tx.query(
      `SELECT a.owner,a.epoch,a.assignment_key,a.delivery_id,
         CASE WHEN octet_length(a.binding::text)<=${OWNER_ASSIGNMENT_BINDING_MAX_BYTES} THEN a.binding ELSE '{}'::jsonb END AS binding,a.retired,
         e.owner_id AS source_owner,e.id AS source_event_id,e.namespace AS source_namespace,CASE WHEN jsonb_typeof(e.metadata->'actionId')='string' AND char_length(e.metadata->>'actionId')<=1024 THEN e.metadata->>'actionId' END AS source_action_id,
         CASE WHEN jsonb_typeof(e.metadata->'actionRunId')='string' AND char_length(e.metadata->>'actionRunId')<=1024 THEN e.metadata->>'actionRunId' END AS source_action_run_id,d.consumer_id AS source_consumer
       FROM ${name} a JOIN ${tables.event_deliveries} d ON d.id=a.delivery_id JOIN ${tables.events} e ON e.id=d.event_id
       WHERE a.owner=$1 AND a.epoch=$2 AND a.assignment_key=$3 AND a.retired=FALSE FOR SHARE OF a`,
      [ownerId, identity.ownerEpoch, key],
    );
    if (
      !currentStarted({ ...identity, principal: { ...identity.principal } })
    ) return undefined;
    if (!result.rows.length) return undefined;
    const row = parseOwnerStoredAssignment(result.rows[0]);
    const value = row.binding;
    if (
      value.placement !== "worker" || row.owner !== ownerId ||
      row.epoch !== identity.ownerEpoch || row.key !== key || row.retired ||
      !matchesSource(result.rows[0], value)
    ) return undefined;
    for (
      const field of [
        "workerId",
        "workerAttemptId",
        "sessionGeneration",
        "sessionId",
        "parentOperationId",
        "assignmentId",
      ] as const
    ) {
      if (
        value[field] !==
          (field === "workerId" ? identity.principal.workerId : identity[field])
      ) return undefined;
    }
    return { ...value };
  }
  /** Resolve reservation facts inside the actual owner command transaction.
   * The supplied executor must retain the owner-row lock through the assignment
   * read. An ambient session or a returned binding is not execution authority. */
  async function resolveLocal(
    tx: SqlExecutor,
    caller: OwnerCaller,
  ): Promise<OwnerLocalAssignmentBinding | undefined> {
    if (
      !currentLocal || caller.principal.kind !== "owner-local" ||
      Object.hasOwn(caller, "workerId")
    ) return undefined;
    const identity: OwnerCaller & { principal: typeof caller.principal } = {
      ...caller,
      principal: { ...caller.principal },
    };
    try {
      ownerPrincipalIdentity(identity.principal);
    } catch {
      return undefined;
    }
    const principal = identity.principal;
    if (
      principal.ownerId !== ownerId || principal.epoch !== identity.ownerEpoch
    ) return undefined;
    const expected = (): OwnerLocalAssignmentBinding | undefined => {
      const supplied = currentLocal({
        ...identity,
        principal: { ...principal },
      });
      if (supplied === undefined) return undefined;
      const value = parseOwnerPlacementBinding(supplied);
      if (
        value.placement !== "owner-local" || value.ownerId !== ownerId ||
        value.epoch !== principal.epoch ||
        value.holderId !== principal.holderId ||
        value.deliveryId !== principal.deliveryId ||
        value.attemptId !== principal.attemptId
      ) return undefined;
      return value;
    };
    const before = expected();
    if (!before) return undefined;
    const key = ownerAssignmentKey(ownerId, before);
    // Direct internal resolution preserves the owner -> assignment lock order.
    const fence = await tx.query(
      `SELECT owner FROM ${epochs} WHERE owner=$1 AND epoch=$2 AND holder=$3 FOR SHARE`,
      [ownerId, principal.epoch, principal.holderId],
    );
    if (fence.rows.length !== 1) return undefined;
    const result = await tx.query(
      `SELECT a.owner,a.epoch,a.assignment_key,a.delivery_id,
         CASE WHEN octet_length(a.binding::text)<=${OWNER_ASSIGNMENT_BINDING_MAX_BYTES} THEN a.binding ELSE '{}'::jsonb END AS binding,a.retired,
         e.owner_id AS source_owner,e.id AS source_event_id,e.namespace AS source_namespace,CASE WHEN jsonb_typeof(e.metadata->'actionId')='string' AND char_length(e.metadata->>'actionId')<=1024 THEN e.metadata->>'actionId' END AS source_action_id,
         CASE WHEN jsonb_typeof(e.metadata->'actionRunId')='string' AND char_length(e.metadata->>'actionRunId')<=1024 THEN e.metadata->>'actionRunId' END AS source_action_run_id,d.consumer_id AS source_consumer
       FROM ${name} a JOIN ${tables.event_deliveries} d ON d.id=a.delivery_id JOIN ${tables.events} e ON e.id=d.event_id
       WHERE a.owner=$1 AND a.epoch=$2 AND a.assignment_key=$3 AND a.retired=FALSE
         FOR SHARE OF a`,
      [ownerId, principal.epoch, key],
    );
    const after = expected();
    if (!after || !result.rows.length) return undefined;
    const row = parseOwnerStoredAssignment(result.rows[0]);
    if (
      row.owner !== ownerId || row.epoch !== principal.epoch ||
      row.key !== key || row.retired ||
      row.binding.placement !== "owner-local" ||
      !matchesSource(result.rows[0], row.binding) ||
      JSON.stringify(row.binding) !== JSON.stringify(before) ||
      JSON.stringify(after) !== JSON.stringify(before)
    ) return undefined;
    return { ...row.binding };
  }
  async function validateLocalContext(
    context: OwnerCommandContext,
    binding: OwnerLocalAssignmentBinding,
    reserve: boolean,
  ): Promise<OwnerLocalAssignmentBinding> {
    const value = parseOwnerPlacementBinding(binding);
    const owner = context.ownerCommit;
    const principal = context.caller.principal;
    ownerPrincipalIdentity(principal);
    if (
      value.placement !== "owner-local" || owner.transaction !== context.tx ||
      owner.ownerId !== ownerId || value.ownerId !== ownerId ||
      owner.epoch !== value.epoch || owner.holderId !== value.holderId ||
      owner.commandTime !== context.commandTime ||
      context.caller.ownerEpoch !== value.epoch ||
      principal.kind === "worker" ||
      (reserve && principal.kind !== "owner-control") ||
      principal.ownerId !== ownerId || principal.epoch !== value.epoch ||
      principal.holderId !== value.holderId ||
      (principal.kind === "owner-local" &&
        (principal.deliveryId !== value.deliveryId ||
          principal.attemptId !== value.attemptId))
    ) {
      throw new Error(
        "Local reservation requires exact current command authority.",
      );
    }
    const fence = await context.tx.query(
      `SELECT owner FROM ${epochs} WHERE owner=$1 AND epoch=$2 AND holder=$3 FOR SHARE`,
      [ownerId, value.epoch, value.holderId],
    );
    if (fence.rows.length !== 1) {
      throw new Error("Local assignment owner fence is no longer current.");
    }
    return value;
  }
  /** Internal SQL-only seam. The caller has already proved its private start
   * capability and locked operation -> delivery before reserving this entry. */
  async function reserveLocal(
    context: OwnerCommandContext,
    binding: OwnerLocalAssignmentBinding,
  ): Promise<void> {
    const value = await validateLocalContext(context, binding, true);
    await bind(value, context);
  }
  /** Exact current-epoch retirement joins completion and its outer commit. */
  async function retireLocal(
    context: OwnerCommandContext,
    binding: OwnerLocalAssignmentBinding,
  ): Promise<void> {
    const value = await validateLocalContext(context, binding, false);
    await retire(value, context);
  }
  return {
    handlers: { "assignment.bind": bind, "assignment.retire": retire },
    authorize,
    resolveStarted,
    resolveLocal,
    reserveLocal,
    retireLocal,
  };
}
