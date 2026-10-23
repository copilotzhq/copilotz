import { appendDatabaseBody } from "./database-body-store.ts";
import { afterSqlCommit } from "../events/session.ts";
import { invalidateOwnerAlarm } from "../engine/alarms.ts";
import { canonicalJson as canonical } from "../data-only-json.ts";
/** One owner-authoritative lifecycle for logical bodies and their physical copies. */
import { createCoreTableNames } from "../events/schema.ts";
import {
  discardOwnerBodyTail,
  notifyOwnerBodyChange,
  openOwnerBodyTail,
  type OwnerBodyTail,
  type OwnerPushWatch,
  stageOwnerBodyChange,
  watchOwnerPush,
} from "../events/push.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import type {
  AppendBodyInput,
  BodyStore,
  MutableBodyHead,
  ReadyBodyHead,
  TerminalBodyHead,
} from "./body-store.ts";
import { createContentError } from "./errors.ts";
import {
  capturePendingContentDescriptor,
  capturePendingContentRef,
} from "./schema.ts";
import type { PendingContentDescriptor, PendingContentRef } from "./types.ts";

export const CONTENT_PROTECTION_MS = 60_000;
export const CONTENT_REPLAY_RETENTION_MS = 24 * 60 * 60_000;
export const CONTENT_CHUNK_BYTES = 1024 * 1024;
export type ContentWriter = Readonly<
  { bodyId: string; writerId: string; generation: number }
>;
export type ContentCopy = Readonly<
  {
    key: string;
    backendKind: string;
    backendId: string;
    versionToken?: string;
    collectable?: boolean;
  }
>;
export type PendingDescriptorInput = Readonly<
  {
    ref: string;
    producer: string;
    descriptor: PendingContentDescriptor;
    expiresAt: string;
  }
>;
export type ContentSeal = Readonly<
  { length: number; digest: `sha256:${string}` }
>;
export type ContentTerminal = Readonly<
  & { length: number; reason?: string }
  & (
    | { outcome: "completed"; digest: `sha256:${string}` }
    | { outcome: "failed" | "cancelled"; digest?: never }
  )
>;
export type LogicalBody = Readonly<
  ContentWriter & {
    namespace: string;
    copy: ContentCopy;
    revocation: "active" | "revoking" | "revoked";
    protectedUntil: string;
    committedOffset: number;
    sealIntent?: ContentSeal;
    terminal?: ContentTerminal;
    promotionTarget?: ContentCopy & { expiresAt: string };
  }
>;
type BodyRow = Record<string, unknown> & {
  body_id: string;
  namespace: string;
  current_copy: string;
  writer_id: string;
  generation: string | number;
  revocation: LogicalBody["revocation"];
  protected_until: string | Date;
  committed_offset: string | number;
  seal_intent: ContentSeal | null;
  terminal: ContentTerminal | null;
  promotion_target: LogicalBody["promotionTarget"] | null;
  backend_kind: string;
  backend_id: string;
  version_token: string | null;
  collectable: boolean;
};
const conflict = (message: string): never => {
  throw createContentError("asset_conflict", message);
};
const number = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Content offset must be a safe non-negative integer.");
  }
  return value;
};
const text = (value: string): string => {
  if (
    typeof value !== "string" || !value || value.trim() !== value ||
    value.length > 4096
  ) throw new TypeError("Invalid content identity.");
  return value;
};
const json = <T>(value: T | string): T =>
  typeof value === "string" ? JSON.parse(value) : value;

function map(row: BodyRow): LogicalBody {
  return {
    bodyId: row.body_id,
    namespace: row.namespace,
    writerId: row.writer_id,
    generation: Number(row.generation),
    revocation: row.revocation,
    protectedUntil: new Date(row.protected_until).toISOString(),
    committedOffset: Number(row.committed_offset),
    copy: {
      key: row.current_copy,
      backendKind: row.backend_kind,
      backendId: row.backend_id,
      collectable: row.collectable,
      ...(row.version_token ? { versionToken: row.version_token } : {}),
    },
    ...(row.seal_intent ? { sealIntent: json(row.seal_intent) } : {}),
    ...(row.terminal ? { terminal: json(row.terminal) } : {}),
    ...(row.promotion_target
      ? { promotionTarget: json(row.promotion_target) }
      : {}),
  };
}
function sameWriter(body: LogicalBody, writer: ContentWriter): boolean {
  return body.bodyId === writer.bodyId && body.writerId === writer.writerId &&
    body.generation === writer.generation;
}

export interface ContentCatalog {
  read(bodyId: string, executor?: SqlExecutor): Promise<LogicalBody | null>;
  readMany?(bodyIds: readonly string[]): Promise<readonly LogicalBody[]>;
  nextDeadline(executor?: SqlExecutor): Promise<string | null>;
  retirementCandidates(input?: {
    limit?: number;
    after?: string;
    now?: Date;
  }): Promise<(ContentCopy & { bodyId: string; state: string })[]>;
  expireReservations(): Promise<void>;
  deferRecovery(bodyId: string): Promise<void>;
  deferRetirement(copyKey: string): Promise<void>;
  recoveryCandidates(
    input?: { limit?: number; after?: string },
  ): Promise<LogicalBody[]>;
  watch(bodyId: string): Promise<OwnerPushWatch>;
  /** Invalidates physical reads, without accepting bytes or changing semantic history. */
  notifyPhysicalChange(bodyId: string): void;
  openTail(bodyId: string): OwnerBodyTail;
  reserve(
    input: ContentWriter & {
      namespace: string;
      copy: ContentCopy;
      protectForMs?: number;
    },
  ): Promise<LogicalBody>;
  checkpoint(
    input: ContentWriter & {
      expectedOffset: number;
      offset: number;
      databaseAppend?: AppendBodyInput;
    },
  ): Promise<number>;
  renew(input: ContentWriter & { deadline: string }): Promise<string>;
  beginRevocation(
    input: ContentWriter & { expiredOnly?: boolean },
  ): Promise<LogicalBody>;
  revoked(input: ContentWriter): Promise<number>;
  sealIntent(
    input: ContentWriter & ContentSeal & {
      pending?: PendingDescriptorInput;
      /** Final checkpoint and seal intent are one atomic writer step. */
      expectedOffset?: number;
      databaseAppend?: AppendBodyInput;
    },
  ): Promise<ContentSeal>;
  sealAccepted(
    input: ContentWriter & {
      head: ReadyBodyHead;
      pending?: PendingDescriptorInput;
    },
  ): Promise<ContentTerminal>;
  recordFailure(
    input: ContentWriter & {
      outcome?: "failed" | "cancelled";
      reason?: string;
    },
  ): Promise<ContentTerminal>;
  reservePromotion(
    input: { bodyId: string; target: ContentCopy; expiresAt: string },
  ): Promise<void>;
  finishPromotion(
    input: { bodyId: string; targetKey: string; head: ReadyBodyHead | null },
  ): Promise<boolean>;
  resolvePending(
    namespace: string,
    source: PendingContentRef,
    executor?: SqlExecutor,
  ): Promise<
    {
      body: LogicalBody;
      descriptor: PendingContentDescriptor;
      producer: string;
      ownerId?: string;
    }
  >;
  adoptPending(
    transaction: SqlExecutor,
    input: {
      namespace: string;
      pendingRef: string;
      ownerId: string;
      assetId: string;
    },
  ): Promise<string>;
}

export function createContentCatalog(
  session: SqlSession | SqlExecutor,
  schema: string,
): ContentCatalog {
  const tables = createCoreTableNames(schema);
  const runner = createSchemaCommandRunner(session, schema);
  let ownerSignal: AbortSignal | undefined;
  let deadlineTables:
    | Promise<{ present: boolean; streams_present: boolean }>
    | undefined;
  const command: ReturnType<typeof createSchemaCommandRunner> = (
    kind,
    input,
    execute,
  ) =>
    runner(kind, input, async (value, context) => {
      ownerSignal = context.signal;
      const result = await execute(value, context);
      if (
        (kind === "content.revoke" &&
          (result as LogicalBody).revocation !== "active") ||
        kind === "content.failed" || kind === "content.sealAccepted"
      ) {
        const bodyId = (value as ContentWriter).bodyId;
        afterSqlCommit(context.transaction, () =>
          discardOwnerBodyTail(context.signal, bodyId));
      }
      if (kind !== "content.checkpoint") {
        invalidateOwnerAlarm(context.transaction, schema, "content");
      }
      const id = (value as { bodyId?: string })?.bodyId;
      if (id && kind !== "content.renew" && kind !== "content.deferRecovery") {
        stageOwnerBodyChange(context.transaction, schema, id);
      }
      return result;
    });
  async function read(
    bodyId: string,
    executor = session,
  ): Promise<LogicalBody | null> {
    const rows = await executor.query<BodyRow>(
      `SELECT b.*, c.backend_kind, c.backend_id, c.version_token, c.collectable
      FROM ${tables.content_logical_bodies} b JOIN ${tables.content_copies} c ON c.copy_key=b.current_copy
      WHERE b.body_id=$1`,
      [bodyId],
    );
    return rows.rows[0] ? map(rows.rows[0]) : null;
  }
  async function requireBody(bodyId: string, executor = session) {
    const body = await read(bodyId, executor);
    if (!body) {
      throw createContentError(
        "content_missing",
        "Logical content body is unavailable.",
      );
    }
    return body;
  }
  async function assertUntombstoned(
    copy: ContentCopy,
    transaction: SqlExecutor,
  ) {
    const rows = await transaction.query(
      `SELECT 1 FROM ${tables.content_copies}
      WHERE copy_key=$1 AND state IN ('retiring','retired') UNION ALL
      SELECT 1 FROM ${tables.owner_body_retirements} WHERE body_id=$1 AND backend_kind=$2 AND backend_id=$3`,
      [
        copy.key,
        copy.backendKind,
        copy.backendKind === "database" ? "" : copy.backendId,
      ],
    );
    if (rows.rows.length) {
      conflict(
        "A tombstoned physical copy cannot become current or be adopted.",
      );
    }
  }
  async function appendCheckpoint(
    transaction: SqlExecutor,
    input: ContentWriter,
    append: AppendBodyInput | undefined,
    start: number | undefined,
    end: number,
  ) {
    if (!append) return;
    const body = await requireBody(input.bodyId, transaction);
    if (
      !sameWriter(body, input) || body.revocation !== "active" ||
      body.terminal ||
      body.copy.backendKind !== "database" ||
      append.writer.bodyId !== body.copy.key ||
      append.writer.reservationId !== input.writerId ||
      append.writer.generation !== input.generation ||
      append.expectedOffset !== start ||
      append.expectedOffset + append.bytes.length !== end
    ) {
      conflict(
        "Checkpoint bytes must belong to the active writer and exact prefix.",
      );
    }
    await appendDatabaseBody(transaction, schema, append);
  }
  async function savePending(
    transaction: SqlExecutor,
    body: LogicalBody,
    input: PendingDescriptorInput,
  ) {
    const descriptor = capturePendingContentDescriptor(input.descriptor);
    text(input.ref);
    text(input.producer);
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      throw new TypeError("Invalid pending expiry.");
    }
    await transaction.query(
      `INSERT INTO ${tables.pending_content}(namespace,pending_ref,body_id,producer,descriptor,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(namespace,pending_ref) DO NOTHING`,
      [
        body.namespace,
        input.ref,
        body.bodyId,
        input.producer,
        JSON.stringify(descriptor),
        input.expiresAt,
      ],
    );
    const existing = (await transaction.query<
      {
        body_id: string;
        producer: string;
        descriptor: PendingContentDescriptor;
      }
    >(
      `SELECT body_id,producer,descriptor FROM ${tables.pending_content} WHERE namespace=$1 AND pending_ref=$2`,
      [body.namespace, input.ref],
    )).rows[0];
    if (
      existing.body_id !== body.bodyId ||
      existing.producer !== input.producer ||
      canonical(json(existing.descriptor)) !== canonical(descriptor)
    ) conflict("Pending content identity is already used.");
  }
  async function pendingState(
    namespace: string,
    pendingRef: string,
    executor: SqlExecutor,
  ) {
    const row = (await executor.query<
      BodyRow & {
        descriptor: PendingContentDescriptor;
        producer: string;
        owner_id: string | null;
        live: boolean;
        tombstoned: boolean;
      }
    >(
      `SELECT b.*,c.backend_kind,c.backend_id,c.version_token,c.collectable,
      p.descriptor,p.producer,a.owner_id,
      (p.expires_at>NOW() OR a.owner_id IS NOT NULL) AS live,
      (c.state IN ('retiring','retired') OR EXISTS(SELECT 1 FROM ${tables.owner_body_retirements} r
        WHERE r.body_id=c.copy_key AND r.backend_kind=c.backend_kind
        AND r.backend_id=CASE WHEN c.backend_kind='database' THEN '' ELSE c.backend_id END)) AS tombstoned
      FROM ${tables.pending_content} p
      JOIN ${tables.content_logical_bodies} b ON b.body_id=p.body_id
      JOIN ${tables.content_copies} c ON c.copy_key=b.current_copy
      LEFT JOIN ${tables.content_adoptions} a ON a.namespace=p.namespace AND a.pending_ref=p.pending_ref
      WHERE p.namespace=$1 AND p.pending_ref=$2`,
      [namespace, pendingRef],
    )).rows[0];
    if (row && !row.live) {
      const operations = `"${schema}"."copilotz_operations"`;
      const present = (await executor.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [operations],
      )).rows[0]?.present;
      row.live = !!present && (await executor.query(
            `SELECT 1 FROM ${operations} WHERE namespace=$1 AND operation_id=$2 AND state IN ('accepted','running')`,
            [namespace, row.producer],
          )).rows.length > 0;
    }
    if (!row?.live) {
      throw createContentError(
        "content_missing",
        "Pending content descriptor is unavailable or expired.",
      );
    }
    if (row.tombstoned) {
      conflict(
        "A tombstoned physical copy cannot become current or be adopted.",
      );
    }
    return row;
  }
  // Scheduling and collection must agree on durable protection. These guards
  // are hints for candidate selection; the fenced retirement claim rechecks them.
  async function retentionGuards(executor: SqlExecutor, time = "NOW()") {
    const operations = `"${schema}"."copilotz_operations"`;
    const streams = `"${schema}"."copilotz_operation_streams"`;
    deadlineTables ??= executor.query<
      { present: boolean; streams_present: boolean }
    >(
      "SELECT to_regclass($1) IS NOT NULL AS present, to_regclass($2) IS NOT NULL AS streams_present",
      [operations, streams],
    ).then((result) => result.rows[0]);
    const { present, streams_present: streamsPresent } = await deadlineTables;
    const pendingGuard = present
      ? `AND NOT EXISTS(SELECT 1 FROM ${operations} o WHERE o.namespace=p.namespace AND o.operation_id=p.producer AND o.state IN ('accepted','running'))`
      : "";
    const streamGuard = streamsPresent
      ? `AND NOT EXISTS(SELECT 1 FROM ${streams} s WHERE s.body_id=b.body_id AND s.availability='retained' AND s.cleanup_state IS NULL)`
      : "";
    const producerGuard = present
      ? `AND NOT EXISTS(SELECT 1 FROM ${tables.pending_content} p JOIN ${operations} o ON o.operation_id=p.producer AND o.namespace=p.namespace WHERE p.body_id=b.body_id AND o.state IN ('accepted','running'))`
      : "";
    const currentGuard = `b.terminal IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ${tables.nodes} n WHERE n.type IN ('asset','protected_value') AND n.data->>'state'='ready' AND (n.data->>'bodyId') COLLATE "C"=b.body_id)
      AND NOT EXISTS(SELECT 1 FROM ${tables.pending_content} p WHERE p.body_id=b.body_id AND p.expires_at>${time})
      ${streamGuard} ${producerGuard}`;
    return { pendingGuard, currentGuard };
  }
  return {
    read,
    async readMany(bodyIds) {
      if (!bodyIds.length) return [];
      const rows = await session.query<BodyRow>(
        `SELECT b.*, c.backend_kind, c.backend_id, c.version_token, c.collectable
         FROM ${tables.content_logical_bodies} b JOIN ${tables.content_copies} c ON c.copy_key=b.current_copy
         WHERE b.body_id=ANY($1::text[])`,
        [[...new Set(bodyIds)]],
      );
      return rows.rows.map(map);
    },
    async nextDeadline(
      executor: SqlExecutor = session,
    ): Promise<string | null> {
      const { pendingGuard, currentGuard } = await retentionGuards(executor);
      const eligibleCopy =
        `c.collectable AND c.state IN ('current','orphan','retiring')`;
      // Each branch walks its due index until the first eligible row. The join
      // guards use identity/body indexes; only six candidate timestamps reach
      // the final MIN, rather than sorting every retained logical body.
      const row = (await executor.query<{ deadline: Date | string | null }>(
        `SELECT MIN(deadline) AS deadline FROM (
        (SELECT COALESCE(recovery_after,protected_until) AS deadline FROM ${tables.content_logical_bodies} WHERE terminal IS NULL ORDER BY COALESCE(recovery_after,protected_until) LIMIT 1)
        UNION ALL (SELECT (promotion_target->>'expiresAt')::timestamptz AS deadline FROM ${tables.content_logical_bodies} WHERE promotion_target IS NOT NULL ORDER BY promotion_target->>'expiresAt' LIMIT 1)
        UNION ALL (SELECT expires_at AS deadline FROM ${tables.pending_content} p WHERE NOT EXISTS(SELECT 1 FROM ${tables.content_adoptions} a WHERE a.namespace=p.namespace AND a.pending_ref=p.pending_ref) ${pendingGuard} ORDER BY expires_at LIMIT 1)
        UNION ALL (SELECT c.retire_after AS deadline FROM ${tables.content_copies} c JOIN ${tables.content_logical_bodies} b ON b.body_id=c.body_id WHERE ${eligibleCopy} AND c.copy_key<>b.current_copy ORDER BY c.retire_after LIMIT 1)
        UNION ALL (SELECT c.retire_after AS deadline FROM ${tables.content_copies} c JOIN ${tables.content_logical_bodies} b ON b.body_id=c.body_id WHERE ${eligibleCopy} AND c.copy_key=b.current_copy AND c.retire_after>=b.protected_until AND ${currentGuard} ORDER BY c.retire_after LIMIT 1)
        UNION ALL (SELECT b.protected_until AS deadline FROM ${tables.content_logical_bodies} b JOIN ${tables.content_copies} c ON c.copy_key=b.current_copy WHERE ${eligibleCopy} AND c.retire_after<b.protected_until AND ${currentGuard} ORDER BY b.protected_until LIMIT 1)
      ) due`,
      )).rows[0];
      return row?.deadline ? new Date(row.deadline).toISOString() : null;
    },
    async retirementCandidates(input = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
        throw new TypeError("Invalid retirement page size.");
      }
      const { currentGuard } = await retentionGuards(
        session,
        "$3::timestamptz",
      );
      const rows = await session.query<{
        copy_key: string;
        backend_kind: string;
        backend_id: string;
        body_id: string;
        state: string;
      }>(
        `SELECT c.copy_key,c.backend_kind,c.backend_id,c.body_id,c.state
         FROM ${tables.content_copies} c
         JOIN ${tables.content_logical_bodies} b ON b.body_id=c.body_id
         WHERE c.collectable AND c.state IN ('current','orphan','retiring')
           AND c.retire_after<=$3::timestamptz
           AND ($1::text IS NULL OR c.copy_key>$1)
           AND (c.copy_key<>b.current_copy OR
             (b.protected_until<=$3::timestamptz AND ${currentGuard}))
         ORDER BY c.copy_key LIMIT $2`,
        [input.after ?? null, limit, (input.now ?? new Date()).toISOString()],
      );
      return rows.rows.map((row) => ({
        key: row.copy_key,
        backendKind: row.backend_kind,
        backendId: row.backend_id,
        bodyId: row.body_id,
        state: row.state,
      }));
    },
    async expireReservations() {
      return await command(
        "content.expireReservations",
        {},
        async (_, { transaction, commandTime }) => {
          const targets = await transaction.query<
            { body_id: string; copy_key: string }
          >(
            `UPDATE ${tables.content_logical_bodies} SET promotion_target=NULL WHERE promotion_target IS NOT NULL AND promotion_target->>'expiresAt'<=$1 RETURNING body_id`,
            [commandTime],
          );
          for (const target of targets.rows) {
            await transaction.query(
              `UPDATE ${tables.content_copies} SET state='orphan' WHERE body_id=$1 AND state='target'`,
              [target.body_id],
            );
          }
          const operations = `"${schema}"."copilotz_operations"`;
          const present = (await transaction.query<{ present: boolean }>(
            "SELECT to_regclass($1) IS NOT NULL AS present",
            [operations],
          )).rows[0]?.present;
          const guard = present
            ? `AND NOT EXISTS(SELECT 1 FROM ${operations} o WHERE o.namespace=p.namespace AND o.operation_id=p.producer AND o.state IN ('accepted','running'))`
            : "";
          await transaction.query(
            `DELETE FROM ${tables.pending_content} p WHERE expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM ${tables.content_adoptions} a WHERE a.namespace=p.namespace AND a.pending_ref=p.pending_ref) ${guard}`,
            [commandTime],
          );
        },
      );
    },
    async deferRetirement(copyKey: string) {
      return await command(
        "content.deferRetirement",
        { copyKey },
        async (input, { transaction, commandTime }) => {
          await transaction.query(
            `UPDATE ${tables.content_copies} SET retire_after=$2 WHERE copy_key=$1 AND state<>'retired'`,
            [
              input.copyKey,
              new Date(Date.parse(commandTime) + 1000).toISOString(),
            ],
          );
        },
      );
    },
    async deferRecovery(bodyId: string) {
      return await command(
        "content.deferRecovery",
        { bodyId },
        async (input, { transaction, commandTime }) => {
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET recovery_after=$2 WHERE body_id=$1 AND terminal IS NULL`,
            [
              input.bodyId,
              new Date(Date.parse(commandTime) + 1000).toISOString(),
            ],
          );
        },
      );
    },
    async recoveryCandidates(input: { limit?: number; after?: string } = {}) {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
        throw new TypeError("Invalid recovery page size.");
      }
      const rows = await session.query<{ body_id: string }>(
        `SELECT body_id FROM ${tables.content_logical_bodies} WHERE terminal IS NULL AND COALESCE(recovery_after,protected_until)<=NOW() AND ($1::text IS NULL OR body_id>$1) ORDER BY body_id LIMIT $2`,
        [input.after ?? null, limit],
      );
      return await Promise.all(
        rows.rows.map((row) => requireBody(row.body_id)),
      );
    },
    openTail(bodyId: string) {
      if (!ownerSignal) {
        throw new Error(
          "Stream reservation must commit before its tail opens.",
        );
      }
      return openOwnerBodyTail(ownerSignal, bodyId);
    },
    watch(bodyId: string) {
      return watchOwnerPush(session, schema, { bodyId });
    },
    notifyPhysicalChange(bodyId: string) {
      if (ownerSignal) notifyOwnerBodyChange(ownerSignal, bodyId);
    },
    async reserve(
      input: ContentWriter & {
        namespace: string;
        copy: ContentCopy;
        protectForMs?: number;
      },
    ) {
      text(input.bodyId);
      text(input.writerId);
      text(input.namespace);
      text(input.copy.key);
      if (number(input.generation) < 1) {
        throw new TypeError("Writer generation must be positive.");
      }
      return await command(
        "content.reserve",
        input,
        async (input, { transaction, commandTime }) => {
          const current = await read(input.bodyId, transaction);
          if (current) {
            if (
              !sameWriter(current, input) ||
              current.copy.key !== input.copy.key ||
              current.namespace !== input.namespace ||
              current.revocation !== "active" || current.terminal
            ) conflict("Content reservation identity is already used.");
            return current;
          }
          await assertUntombstoned(input.copy, transaction);
          const protectedUntil = new Date(
            Date.parse(commandTime) +
              number(input.protectForMs ?? CONTENT_PROTECTION_MS),
          ).toISOString();
          await transaction.query(
            `INSERT INTO ${tables.content_logical_bodies}(body_id,namespace,current_copy,writer_id,generation,protected_until)
          VALUES($1,$2,$3,$4,$5,$6)`,
            [
              input.bodyId,
              input.namespace,
              input.copy.key,
              input.writerId,
              input.generation,
              protectedUntil,
            ],
          );
          await transaction.query(
            `INSERT INTO ${tables.content_copies}(copy_key,backend_kind,backend_id,body_id,state,collectable)
          VALUES($1,$2,$3,$4,'current',$5)`,
            [
              input.copy.key,
              input.copy.backendKind,
              input.copy.backendId,
              input.bodyId,
              input.copy.collectable ?? false,
            ],
          );
          return await requireBody(input.bodyId, transaction);
        },
      );
    },
    async checkpoint(
      input: ContentWriter & {
        expectedOffset: number;
        offset: number;
        databaseAppend?: AppendBodyInput;
      },
    ) {
      number(input.expectedOffset);
      number(input.offset);
      if (input.offset < input.expectedOffset) {
        throw new TypeError("Checkpoint must not move backwards.");
      }
      return await command(
        "content.checkpoint",
        input,
        async (input, { transaction }) => {
          await appendCheckpoint(
            transaction,
            input,
            input.databaseAppend,
            input.expectedOffset,
            input.offset,
          );
          const result = await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET committed_offset=$5
              WHERE body_id=$1 AND writer_id=$2 AND generation=$3
              AND revocation='active' AND terminal IS NULL AND seal_intent IS NULL
              AND committed_offset IN ($4,$5) RETURNING committed_offset`,
            [
              input.bodyId,
              input.writerId,
              input.generation,
              input.expectedOffset,
              input.offset,
            ],
          );
          if (!result.rows.length) {
            conflict("Checkpoint does not extend the active catalog prefix.");
          }
          return input.offset;
        },
      );
    },
    async renew(input: ContentWriter & { deadline: string }) {
      if (!Number.isFinite(Date.parse(input.deadline))) {
        throw new TypeError("Invalid content protection deadline.");
      }
      return await command(
        "content.renew",
        input,
        async (input, { transaction }) => {
          const body = await requireBody(input.bodyId, transaction);
          if (
            !sameWriter(body, input) || body.revocation !== "active" ||
            body.terminal
          ) conflict("A revoking or revoked writer cannot renew.");
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET protected_until=GREATEST(protected_until,$2::timestamptz),recovery_after=NULL WHERE body_id=$1`,
            [input.bodyId, input.deadline],
          );
          return input.deadline;
        },
      );
    },
    async beginRevocation(input: ContentWriter & { expiredOnly?: boolean }) {
      return await command(
        "content.revoke",
        input,
        async (input, { transaction, commandTime }) => {
          const body = await requireBody(input.bodyId, transaction);
          if (!sameWriter(body, input)) {
            conflict(
              "Content writer identity is stale.",
            );
          }
          if (
            body.terminal ||
            (input.expiredOnly &&
              Date.parse(body.protectedUntil) > Date.parse(commandTime))
          ) return body;
          if (body.revocation !== "active") return body;
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET revocation='revoking' WHERE body_id=$1`,
            [input.bodyId],
          );
          return { ...body, revocation: "revoking" as const };
        },
      );
    },
    async revoked(input: ContentWriter) {
      return await command(
        "content.revoked",
        input,
        async (input, { transaction }) => {
          const body = await requireBody(input.bodyId, transaction);
          if (!sameWriter(body, input) || body.revocation === "active") {
            conflict(
              "Physical fencing must follow a catalog revocation claim.",
            );
          }
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET revocation='revoked' WHERE body_id=$1`,
            [input.bodyId],
          );
          return body.committedOffset;
        },
      );
    },
    async sealIntent(
      input: ContentWriter & ContentSeal & {
        pending?: PendingDescriptorInput;
        /** Final checkpoint and seal intent are one atomic writer step. */
        expectedOffset?: number;
        databaseAppend?: AppendBodyInput;
      },
    ) {
      number(input.length);
      if (input.expectedOffset !== undefined) {
        number(input.expectedOffset);
        if (input.length < input.expectedOffset) {
          throw new TypeError("Checkpoint must not move backwards.");
        }
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(input.digest)) {
        throw new TypeError("Invalid seal digest.");
      }
      return await command(
        "content.sealIntent",
        input,
        async (input, { transaction }) => {
          await appendCheckpoint(
            transaction,
            input,
            input.databaseAppend,
            input.expectedOffset,
            input.length,
          );
          const body = await requireBody(input.bodyId, transaction);
          if (
            !sameWriter(body, input) || body.revocation !== "active" ||
            (body.committedOffset !== input.length &&
              (body.committedOffset !== input.expectedOffset ||
                body.terminal !== undefined || body.sealIntent !== undefined))
          ) conflict("Seal intent requires the active catalog prefix.");
          const intent = { length: input.length, digest: input.digest };
          if (
            body.sealIntent && canonical(body.sealIntent) !== canonical(intent)
          ) conflict("Seal intent cannot be replaced.");
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET seal_intent=$2::jsonb,committed_offset=$3 WHERE body_id=$1`,
            [input.bodyId, JSON.stringify(intent), input.length],
          );
          if (input.pending) {
            await savePending(
              transaction,
              body,
              input.pending,
            );
          }
          return intent;
        },
      );
    },
    async sealAccepted(
      input: ContentWriter & {
        head: ReadyBodyHead;
        pending?: {
          ref: string;
          producer: string;
          descriptor: PendingContentDescriptor;
          expiresAt: string;
        };
      },
    ) {
      const pending = input.pending &&
        {
          ...input.pending,
          descriptor: capturePendingContentDescriptor(input.pending.descriptor),
        };
      return await command(
        "content.sealAccepted",
        { ...input, pending },
        async (input, { transaction, commandTime }) => {
          const body = await requireBody(input.bodyId, transaction);
          const intent = body.sealIntent;
          if (
            !sameWriter(body, input) || !intent ||
            input.head.state !== "ready" ||
            input.head.bodyId !== body.copy.key ||
            input.head.byteLength !== intent.length ||
            input.head.digest !== intent.digest
          ) conflict("Physical seal does not match the catalog intent.");
          await assertUntombstoned(body.copy, transaction);
          const token = text(input.head.versionToken);
          const terminal: ContentTerminal = {
            ...intent!,
            outcome: "completed",
          };
          if (
            body.terminal && canonical(body.terminal) !== canonical(terminal)
          ) conflict("A recorded terminal cannot be changed.");
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET terminal=$2::jsonb WHERE body_id=$1`,
            [body.bodyId, JSON.stringify(terminal)],
          );
          await transaction.query(
            `UPDATE ${tables.content_copies} SET version_token=$2,retire_after=CASE WHEN $3::boolean THEN retire_after ELSE $4::timestamptz END WHERE copy_key=$1`,
            [
              body.copy.key,
              token,
              !!body.terminal,
              new Date(Date.parse(commandTime) + CONTENT_REPLAY_RETENTION_MS)
                .toISOString(),
            ],
          );
          if (input.pending) {
            await savePending(
              transaction,
              body,
              input.pending,
            );
          }
          return terminal;
        },
      );
    },
    async recordFailure(
      input: ContentWriter & {
        outcome?: "failed" | "cancelled";
        reason?: string;
      },
    ) {
      return await command(
        "content.failed",
        input,
        async (input, { transaction }) => {
          const body = await requireBody(input.bodyId, transaction);
          if (
            !sameWriter(body, input) || body.revocation !== "revoked"
          ) conflict("Recovery requires revoked writer authority.");
          if (body.terminal) return body.terminal;
          const terminal: ContentTerminal = {
            outcome: input.outcome ?? "failed",
            length: body.committedOffset,
            ...(input.reason ? { reason: input.reason } : {}),
          };
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET terminal=$2::jsonb WHERE body_id=$1`,
            [body.bodyId, JSON.stringify(terminal)],
          );
          return terminal;
        },
      );
    },
    async reservePromotion(
      input: { bodyId: string; target: ContentCopy; expiresAt: string },
    ) {
      return await command(
        "content.promotion.reserve",
        input,
        async (input, { transaction }) => {
          const expiresAt = new Date(input.expiresAt).toISOString();
          if (expiresAt.length !== 24) {
            throw new TypeError("Invalid promotion deadline.");
          }
          const body = await requireBody(input.bodyId, transaction);
          if (body.terminal?.outcome !== "completed") {
            conflict(
              "Promotion requires accepted sealed content.",
            );
          }
          await assertUntombstoned(input.target, transaction);
          if (body.promotionTarget) {
            conflict(
              "A promotion target is already reserved.",
            );
          }
          await transaction.query(
            `INSERT INTO ${tables.content_copies}(copy_key,backend_kind,backend_id,body_id,state,collectable) VALUES($1,$2,$3,$4,'target',$5)`,
            [
              input.target.key,
              input.target.backendKind,
              input.target.backendId,
              body.bodyId,
              input.target.collectable ?? false,
            ],
          );
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET promotion_target=$2::jsonb WHERE body_id=$1`,
            [
              body.bodyId,
              JSON.stringify({ ...input.target, expiresAt }),
            ],
          );
        },
      );
    },
    async finishPromotion(
      input: { bodyId: string; targetKey: string; head: ReadyBodyHead | null },
    ) {
      return await command(
        "content.promotion.finish",
        input,
        async (input, { transaction, commandTime }) => {
          const body = await requireBody(input.bodyId, transaction);
          const target = body.promotionTarget;
          if (!target || target.key !== input.targetKey) return false;
          const valid = !!input.head && input.head.bodyId === target.key &&
            input.head.byteLength === body.terminal?.length &&
            input.head.digest === body.terminal?.digest &&
            Date.parse(target.expiresAt) > Date.parse(commandTime);
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET promotion_target=NULL WHERE body_id=$1`,
            [body.bodyId],
          );
          if (!valid) {
            await transaction.query(
              `UPDATE ${tables.content_copies} SET state='orphan' WHERE copy_key=$1`,
              [target.key],
            );
            return false;
          }
          await assertUntombstoned(target, transaction);
          await transaction.query(
            `UPDATE ${tables.content_copies} SET state='orphan' WHERE copy_key=$1`,
            [body.copy.key],
          );
          await transaction.query(
            `UPDATE ${tables.content_copies} SET state='current',version_token=$2 WHERE copy_key=$1`,
            [target.key, input.head!.versionToken],
          );
          await transaction.query(
            `UPDATE ${tables.content_logical_bodies} SET current_copy=$2 WHERE body_id=$1`,
            [body.bodyId, target.key],
          );
          return true;
        },
      );
    },
    async resolvePending(
      namespace: string,
      source: PendingContentRef,
      executor: SqlExecutor = session,
    ) {
      const ref = capturePendingContentRef(source);
      const pending = await pendingState(namespace, ref.pendingRef, executor);
      const body = map(pending);
      if (
        body.terminal?.outcome !== "completed" ||
        body.terminal.length !== ref.byteLength ||
        body.terminal.digest !== ref.digest
      ) {
        conflict(
          "Pending content claims do not match their catalog descriptor.",
        );
      }
      return {
        body,
        descriptor: capturePendingContentDescriptor(json(pending.descriptor)),
        producer: pending.producer,
        ...(pending.owner_id ? { ownerId: pending.owner_id } : {}),
      };
    },
    async adoptPending(
      transaction: SqlExecutor,
      input: {
        namespace: string;
        pendingRef: string;
        ownerId: string;
        assetId: string;
      },
    ) {
      invalidateOwnerAlarm(transaction, schema, "content");
      await pendingState(input.namespace, input.pendingRef, transaction);
      const receipt = (await transaction.query<{ asset_id: string }>(
        `INSERT INTO ${tables.content_adoptions} AS a(namespace,pending_ref,owner_id,asset_id)
          VALUES($1,$2,$3,$4) ON CONFLICT(namespace,pending_ref) DO UPDATE SET owner_id=a.owner_id
          WHERE a.owner_id=EXCLUDED.owner_id RETURNING asset_id`,
        [input.namespace, input.pendingRef, input.ownerId, input.assetId],
      )).rows[0];
      if (!receipt) {
        conflict("Pending content already belongs to another domain owner.");
      }
      return receipt.asset_id;
    },
  };
}

/** Re-resolve a vanished or short physical head without changing logical authority. */
export async function readLogicalHead(
  catalog: ContentCatalog,
  bodyId: string,
  storeFor: (copy: ContentCopy) => BodyStore,
): Promise<
  { body: LogicalBody; head: MutableBodyHead | TerminalBodyHead | null } | null
> {
  let body = await catalog.read(bodyId);
  if (!body) return null;
  for (;;) {
    try {
      const head = await storeFor(body.copy).head({ bodyId: body.copy.key });
      if (head && head.byteLength >= (body.terminal?.length ?? 0)) {
        return { body, head };
      }
      const next = await catalog.read(bodyId);
      if (!next || next.copy.key === body.copy.key) return { body, head };
      body = next;
    } catch (error) {
      const next = await catalog.read(bodyId);
      if (!next || next.copy.key === body.copy.key) throw error;
      body = next;
    }
  }
}

/** Finite reads re-resolve the current copy after loss, never replaying delivered bytes. */
export async function openLogicalBody(
  catalog: ContentCatalog,
  bodyId: string,
  storeFor: (copy: ContentCopy) => Pick<BodyStore, "readRange">,
  expectedLength?: number,
): Promise<ReadableStream<Uint8Array>> {
  const initial = await catalog.read(bodyId);
  if (!initial) {
    throw createContentError("content_missing", "Logical body is missing.");
  }
  let offset = 0;
  let body = initial;
  const length = expectedLength ?? initial.terminal?.length;
  if (length === undefined) {
    throw new TypeError("Immutable content reads require a terminal length.");
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        if (offset === length) {
          controller.close();
          return;
        }
        const end = Math.min(length, offset + CONTENT_CHUNK_BYTES);
        let bytes: Uint8Array;
        try {
          bytes = await storeFor(body.copy).readRange({
            bodyId: body.copy.key,
            offset,
            end,
          });
          if (bytes.byteLength !== end - offset) {
            throw createContentError(
              "content_missing",
              "Logical content copy is shorter than its accepted length.",
            );
          }
        } catch (error) {
          const next = await catalog.read(bodyId);
          if (!next || next.copy.key === body.copy.key) throw error;
          body = next;
          bytes = await storeFor(body.copy).readRange({
            bodyId: body.copy.key,
            offset,
            end,
          });
        }
        if (bytes.byteLength !== end - offset) {
          throw createContentError(
            "content_missing",
            "Logical content copy is shorter than its accepted length.",
          );
        }
        offset = end;
        controller.enqueue(bytes);
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
