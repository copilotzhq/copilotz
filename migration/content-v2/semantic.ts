import { ulid } from "../../dependencies/ulid.ts";
import {
  bytesToBase64,
  createContentPreparer,
  digestContent,
  mergePreparedContent,
} from "../../runtime/content/index.ts";
import type {
  ContentRef,
  PreparedAsset,
  PreparedContent,
} from "../../runtime/content/index.ts";
import type { SqlExecutor } from "../../runtime/events/index.ts";
import { extractToolResultAssets } from "../../runtime/workflows/index.ts";
import { quoteEventIdentifier } from "../../runtime/events/schema.ts";

type NodeRow = {
  id: string;
  namespace: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type ToolMessageRepairReport = {
  candidateMessages: number;
  mergedExecutions: number;
  synthesizedExecutions: number;
  extractedAssets: number;
  deletedMessages: number;
  deletedDuplicateEvents: number;
  deletedOrphanAssets: number;
};

function q(schema: string, table: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function iso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

async function jsonDigest(value: unknown): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  return await digestContent(new TextEncoder().encode(encoded));
}

async function executionRoleDigest(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  data: Record<string, unknown>,
  role: string,
  directKeys: readonly string[],
): Promise<string | undefined> {
  for (const key of directKeys) {
    if (Object.hasOwn(data, key)) return await jsonDigest(data[key]);
  }
  const ref = content(data.content).find((candidate) =>
    candidate.role === role
  );
  if (!ref) return undefined;
  const result = await transaction.query<{ data: unknown }>(
    `SELECT data FROM ${q(schema, "nodes")}
     WHERE namespace = $1 AND id = $2 AND type = 'asset' LIMIT 1`,
    [namespace, ref.assetId],
  );
  return text(record(result.rows[0]?.data).digest);
}

async function narrowExecutionMatches(
  transaction: SqlExecutor,
  schema: string,
  row: NodeRow,
  messageData: Record<string, unknown>,
  parsed: ReturnType<typeof oneToolCall>,
  candidates: readonly NodeRow[],
): Promise<readonly NodeRow[]> {
  let narrowed = [...candidates];
  if (narrowed.length <= 1) return narrowed;

  const metadata = record(messageData.metadata);
  const migrated = record(metadata.migratedFromV1);
  const executionHints = new Set(
    [
      parsed.call.toolExecutionId,
      parsed.call.executionId,
      messageData.toolExecutionId,
      metadata.toolExecutionId,
      migrated.toolExecutionId,
    ].map(text).filter((value): value is string => Boolean(value)),
  );
  if (executionHints.size > 0) {
    const exact = narrowed.filter((candidate) =>
      executionHints.has(candidate.id)
    );
    if (exact.length > 0) narrowed = exact;
  }
  if (narrowed.length <= 1) return narrowed;

  const narrowByDigest = async (
    expectedValue: unknown,
    role: string,
    directKeys: readonly string[],
  ) => {
    if (expectedValue === undefined || narrowed.length <= 1) return;
    const expected = await jsonDigest(expectedValue);
    const matches: NodeRow[] = [];
    for (const candidate of narrowed) {
      const actual = await executionRoleDigest(
        transaction,
        schema,
        candidate.namespace,
        record(candidate.data),
        role,
        directKeys,
      );
      if (actual && actual === expected) matches.push(candidate);
    }
    if (matches.length > 0) narrowed = matches;
  };

  // A canonical result body is stronger evidence than a reused provider call ID.
  await narrowByDigest(parsed.call.output, "tool.output", ["output"]);
  await narrowByDigest(
    parsed.call.projectedOutput ?? parsed.call.projected_output,
    "tool.projected_output",
    ["projectedOutput", "projected_output"],
  );
  // Preserve full diagnostic identity. A safeError summary may intentionally
  // differ from the canonical legacy error body, so only direct full errors
  // precede the asset-backed role here.
  await narrowByDigest(parsed.call.error, "tool.error_detail", ["error"]);
  await narrowByDigest(
    parsed.call.args ?? parsed.call.arguments,
    "tool.arguments",
    ["args", "arguments"],
  );
  if (narrowed.length <= 1) return narrowed;

  const participantHints = new Set(
    [
      parsed.call.participantId,
      parsed.call.agentId,
      messageData.participantId,
      messageData.agentId,
      migrated.requestingParticipantId,
      migrated.senderId,
      migrated.senderUserId,
    ].map(text).filter((value): value is string => Boolean(value)),
  );
  if (participantHints.size > 0) {
    const participantMatches = narrowed.filter((candidate) => {
      const data = record(candidate.data);
      return [text(data.participantId), text(data.agentId)].some((value) =>
        value ? participantHints.has(value) : false
      );
    });
    if (participantMatches.length > 0) narrowed = participantMatches;
  }
  if (narrowed.length <= 1) return narrowed;

  const messageHints = new Set(
    [
      parsed.call.messageId,
      messageData.messageId,
      metadata.messageId,
    ].map(text).filter((value): value is string => Boolean(value)),
  );
  if (messageHints.size > 0) {
    const messageMatches = narrowed.filter((candidate) => {
      const messageId = text(record(candidate.data).messageId);
      return messageId ? messageHints.has(messageId) : false;
    });
    if (messageMatches.length > 0) narrowed = messageMatches;
  }
  if (narrowed.length <= 1) return narrowed;

  // A result message cannot have been produced by an execution that started later.
  const resultAt = new Date(row.created_at).getTime();
  const causalMatches = narrowed.filter((candidate) => {
    const data = record(candidate.data);
    const startedAt = text(data.startedAt) ?? iso(candidate.created_at);
    return new Date(startedAt).getTime() <= resultAt;
  });
  if (causalMatches.length > 0) narrowed = causalMatches;
  return narrowed;
}

function jsonMediaType(mediaType: string): boolean {
  const base = mediaType.toLowerCase().split(";", 1)[0].trim();
  return base === "application/json" || base.endsWith("+json");
}

function encodeBody(mediaType: string, body: Uint8Array) {
  if (jsonMediaType(mediaType) || mediaType.toLowerCase().startsWith("text/")) {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (jsonMediaType(mediaType)) JSON.parse(value);
    return {
      body: value,
      location: {
        kind: "database" as const,
        encoding: jsonMediaType(mediaType) ? "json" as const : "utf8" as const,
      },
    };
  }
  return {
    body: bytesToBase64(body),
    location: { kind: "database" as const, encoding: "base64" as const },
  };
}

async function insertPreparedAsset(
  transaction: SqlExecutor,
  schema: string,
  asset: PreparedAsset,
): Promise<void> {
  const encoded = encodeBody(asset.mediaType, asset.body);
  const readyAt = new Date().toISOString();
  await transaction.query(
    `INSERT INTO ${q(schema, "nodes")} (
       id, namespace, type, name, data, source_type, source_id
     ) VALUES ($1, $2, 'asset', $3, $4::jsonb, 'content_v2', $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      asset.id,
      asset.namespace,
      asset.mediaType,
      json({
        mediaType: asset.mediaType,
        byteLength: asset.byteLength,
        digest: asset.digest,
        state: "ready",
        location: encoded.location,
        body: encoded.body,
        readyAt,
        ...(asset.origin ? { origin: asset.origin } : {}),
        metadata: {
          ...(asset.metadata ?? {}),
          migratedBy: "copilotz.content-v2",
        },
      }),
      asset.idempotencyKey ?? asset.id,
    ],
  );
}

async function ensureAssetEdges(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  ownerId: string,
  refs: readonly ContentRef[],
): Promise<void> {
  for (const ref of refs) {
    await transaction.query(
      `INSERT INTO ${q(schema, "edges")} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES ($1, $2, $3, $4, 'has_asset', '{}', 1)
       ON CONFLICT DO NOTHING`,
      [ulid(), namespace, ownerId, ref.assetId],
    );
  }
}

function content(value: unknown): ContentRef[] {
  return Array.isArray(value)
    ? value.filter((item): item is ContentRef =>
      Boolean(item) && typeof item === "object" &&
      typeof (item as ContentRef).assetId === "string"
    ).map((item) => structuredClone(item))
    : [];
}

async function databaseContentValue(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  refs: readonly ContentRef[],
  role: string,
): Promise<unknown | undefined> {
  const ref = refs.find((candidate) => candidate.role === role);
  if (!ref) return undefined;
  const result = await transaction.query<{ data: unknown }>(
    `SELECT data FROM ${q(schema, "nodes")}
     WHERE namespace = $1 AND id = $2 AND type = 'asset' LIMIT 1`,
    [namespace, ref.assetId],
  );
  const data = record(result.rows[0]?.data);
  const location = record(data.location);
  if (
    data.state !== "ready" || location.kind !== "database" ||
    typeof data.body !== "string"
  ) return undefined;
  const textBody = location.encoding === "base64"
    ? new TextDecoder().decode(
      Uint8Array.from(atob(data.body), (character) => character.charCodeAt(0)),
    )
    : data.body;
  if (ref.kind === "json" || jsonMediaType(ref.mediaType)) {
    return JSON.parse(textBody);
  }
  return textBody;
}

async function syncAssetEdges(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  ownerId: string,
  refs: readonly ContentRef[],
): Promise<readonly string[]> {
  const existing = await transaction.query<{ target_node_id: string }>(
    `SELECT target_node_id FROM ${q(schema, "edges")}
     WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
    [namespace, ownerId],
  );
  const retained = new Set(refs.map((ref) => ref.assetId));
  const removed = existing.rows.map((row) => row.target_node_id).filter(
    (assetId) => !retained.has(assetId),
  );
  if (retained.size === 0) {
    await transaction.query(
      `DELETE FROM ${q(schema, "edges")}
       WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
      [namespace, ownerId],
    );
  } else {
    await transaction.query(
      `DELETE FROM ${q(schema, "edges")}
       WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'
         AND NOT (target_node_id = ANY($3::text[]))`,
      [namespace, ownerId, [...retained]],
    );
  }
  await ensureAssetEdges(transaction, schema, namespace, ownerId, refs);
  return Object.freeze(removed);
}

async function deleteUnreferencedMigrationAssets(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  assetIds: readonly string[],
): Promise<number> {
  let deleted = 0;
  for (const assetId of new Set(assetIds)) {
    const removed = await transaction.query<{ id: string }>(
      `DELETE FROM ${q(schema, "nodes")} asset
       WHERE asset.namespace = $1 AND asset.id = $2 AND asset.type = 'asset'
         AND (
           asset.source_type IN (
             'v1_inline_content', 'content_v2', 'asset_idempotency'
           ) OR (asset.data -> 'metadata' -> 'migratedFromV1') IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${q(schema, "edges")} edge
           WHERE edge.namespace = asset.namespace
             AND edge.target_node_id = asset.id AND edge.type = 'has_asset'
         ) RETURNING asset.id`,
      [namespace, assetId],
    );
    deleted += removed.rows.length;
  }
  return deleted;
}

function oneToolCall(data: Record<string, unknown>, messageId: string) {
  const metadata = record(data.metadata);
  const candidates = Array.isArray(metadata.toolCalls)
    ? metadata.toolCalls
    : Array.isArray(data.toolCalls)
    ? data.toolCalls
    : [];
  if (candidates.length !== 1) {
    throw new Error(
      `Legacy tool message '${messageId}' must contain exactly one structured tool call; found ${candidates.length}.`,
    );
  }
  const call = record(candidates[0]);
  const tool = record(call.tool);
  const toolCallId = text(call.id) ?? text(call.toolCallId);
  const toolId = text(tool.id) ?? text(tool.name) ?? text(call.toolId);
  if (!toolCallId || !toolId) {
    throw new Error(
      `Legacy tool message '${messageId}' has an incomplete tool call identity.`,
    );
  }
  return {
    call,
    tool: { ...tool, id: toolId } as Record<string, unknown>,
    toolCallId,
    toolId,
  };
}

function messageThread(row: NodeRow, data: Record<string, unknown>): string {
  const threadId = text(data.threadId) ??
    (row.source_type === "thread" ? text(row.source_id) : undefined);
  if (!threadId) {
    throw new Error(`Legacy tool message '${row.id}' has no thread.`);
  }
  return threadId;
}

async function participantId(
  transaction: SqlExecutor,
  schema: string,
  row: NodeRow,
  data: Record<string, unknown>,
  preferred: readonly unknown[] = [],
): Promise<string | undefined> {
  const migrated = record(record(data.metadata).migratedFromV1);
  const reference = preferred.map(text).find(Boolean) ??
    text(migrated.requestingParticipantId) ??
    text(migrated.senderId) ?? text(data.senderId) ??
    text(migrated.senderUserId) ?? text(data.senderUserId);
  if (!reference) return undefined;
  const found = await transaction.query<{ id: string }>(
    `SELECT id FROM ${q(schema, "nodes")}
     WHERE namespace = $1 AND type = 'participant'
       AND (id = $2 OR data ->> 'externalId' = $2)
     ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END, created_at, id
     LIMIT 2`,
    [row.namespace, reference],
  );
  if (found.rows.length > 1) {
    throw new Error(
      `Legacy tool message '${row.id}' has an ambiguous requesting participant.`,
    );
  }
  if (found.rows[0]) return found.rows[0].id;
  const id = `migration:agent:${row.namespace}:${reference}`;
  await transaction.query(
    `INSERT INTO ${q(schema, "nodes")} (
       id, namespace, type, name, data, source_type, source_id,
       created_at, updated_at
     ) VALUES ($1, $2, 'participant', $3, $4::jsonb,
       'external_id', $3, $5::timestamptz, $5::timestamptz)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      row.namespace,
      reference,
      json({
        externalId: reference,
        participantType: "agent",
        name: reference,
        metadata: { migratedFromV1: { synthesizedForToolMessage: row.id } },
      }),
      iso(row.created_at),
    ],
  );
  return id;
}

async function deleteOrphanedToolParticipant(
  transaction: SqlExecutor,
  schema: string,
  namespace: string,
  data: Record<string, unknown>,
  requestingParticipantId?: string,
): Promise<void> {
  const migrated = record(record(data.metadata).migratedFromV1);
  const reference = text(migrated.senderId) ?? text(data.senderId);
  if (!reference) return;
  const candidate = await transaction.query<{ id: string; data: unknown }>(
    `SELECT id, data FROM ${q(schema, "nodes")}
     WHERE namespace = $1 AND type = 'participant'
       AND (id = $2 OR data ->> 'externalId' = $2)
     ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END, created_at, id LIMIT 1`,
    [namespace, reference],
  );
  const found = candidate.rows[0];
  if (!found || found.id === requestingParticipantId) return;
  const participant = record(found.data);
  if (participant.participantType !== "tool") return;
  await transaction.query(
    `DELETE FROM ${q(schema, "nodes")} participant
     WHERE participant.namespace = $1 AND participant.id = $2
       AND participant.type = 'participant'
       AND NOT EXISTS (
         SELECT 1 FROM ${q(schema, "edges")} edge
         WHERE edge.namespace = participant.namespace
           AND (
             edge.source_node_id = participant.id OR
             edge.target_node_id = participant.id
           )
       )`,
    [namespace, found.id],
  );
}

async function legacyAttachmentRefs(
  transaction: SqlExecutor,
  schema: string,
  row: NodeRow,
  data: Record<string, unknown>,
): Promise<ContentRef[]> {
  const refs = content(data.content).filter((ref) => ref.role === "attachment");
  const attachments = record(data.metadata).attachments;
  if (!Array.isArray(attachments)) return refs;
  for (const candidate of attachments) {
    const fields = record(candidate);
    const raw = text(fields.assetId) ?? text(fields.assetRef);
    const assetId = raw?.startsWith("asset://") ? raw.split("/").at(-1) : raw;
    if (!assetId || refs.some((ref) => ref.assetId === assetId)) continue;
    const asset = await transaction.query<{ data: unknown }>(
      `SELECT data FROM ${q(schema, "nodes")}
       WHERE namespace = $1 AND id = $2 AND type = 'asset' LIMIT 1`,
      [row.namespace, assetId],
    );
    const assetData = record(asset.rows[0]?.data);
    const mediaType = text(assetData.mediaType);
    if (!mediaType) {
      throw new Error(`Legacy attachment '${assetId}' is missing.`);
    }
    refs.push({
      assetId,
      kind: mediaType.startsWith("image/")
        ? "image"
        : mediaType.startsWith("audio/")
        ? "audio"
        : mediaType.startsWith("video/")
        ? "video"
        : "file",
      role: "attachment",
      mediaType,
      ...(text(fields.name) ?? text(fields.fileName)
        ? { name: text(fields.name) ?? text(fields.fileName) }
        : {}),
    });
  }
  return refs;
}

async function prepareRole(
  namespace: string,
  threadId: string,
  executionId: string,
  role: string,
  value: unknown,
): Promise<{ prepared?: PreparedContent; extractedAssets: number }> {
  if (value === undefined) return { extractedAssets: 0 };
  const preparer = createContentPreparer({ createId: ulid });
  const extracted = await extractToolResultAssets(value, {
    namespace,
    threadId,
    toolExecutionId: executionId,
    prepare: (input, options) =>
      preparer.prepare(input, {
        namespace,
        idempotencyKey: `${executionId}:${options.operationKey}`,
      }),
  });
  const body = await preparer.prepare({
    type: "json",
    value: extracted.output,
    role,
    origin: {
      scope: { type: "thread", id: threadId },
      producer: { type: "tool_execution", id: executionId },
    },
  }, { namespace, idempotencyKey: `${executionId}:${role}` });
  return {
    prepared: mergePreparedContent(body, extracted.attachments),
    extractedAssets: extracted.attachments?.assets.length ?? 0,
  };
}

function replaceRoles(
  current: readonly ContentRef[],
  replacements: readonly PreparedContent[],
  roles: ReadonlySet<string>,
): ContentRef[] {
  return [
    ...current.filter((ref) => !roles.has(ref.role)),
    ...replacements.flatMap((batch) => batch.content),
  ];
}

async function sanitizeExistingToolExecutionContent(
  transaction: SqlExecutor,
  schema: string,
  report: ToolMessageRepairReport,
): Promise<void> {
  const roles = new Set(["tool.output", "tool.projected_output"]);
  let cursor = "";
  while (true) {
    const executions = await transaction.query<NodeRow>(
      `SELECT id, namespace, name, content, data, source_type, source_id,
         created_at, updated_at
       FROM ${q(schema, "nodes")}
       WHERE type = 'tool_execution' AND id > $1
       ORDER BY id LIMIT 500`,
      [cursor],
    );
    if (executions.rows.length === 0) break;

    const referencedAssetIds = [
      ...new Set(
        executions.rows.flatMap((row) =>
          content(record(row.data).content)
            .filter((ref) => roles.has(ref.role))
            .map((ref) => ref.assetId)
        ),
      ),
    ];
    const candidateAssets = referencedAssetIds.length === 0
      ? []
      : (await transaction.query<{ id: string; data: unknown }>(
        `SELECT id, data FROM ${q(schema, "nodes")}
         WHERE type = 'asset' AND id = ANY($1::text[])
           AND data ->> 'state' = 'ready'
           AND data -> 'location' ->> 'kind' = 'database'
           AND data -> 'location' ->> 'encoding' IN ('json', 'utf8')
           AND (
             data ->> 'body' LIKE '%data:%'
             OR data ->> 'body' LIKE '%"dataUrl"%'
             OR data ->> 'body' LIKE '%"dataBase64"%'
           )`,
        [referencedAssetIds],
      )).rows;
    const assetsById = new Map(
      candidateAssets.map((asset) => [asset.id, asset.data]),
    );

    for (const execution of executions.rows) {
      const data = record(execution.data);
      const threadId = text(data.threadId);
      if (!threadId) continue;
      let refs = content(data.content);
      const removedAssetIds: string[] = [];
      let changed = false;
      for (const role of roles) {
        const ref = refs.find((candidate) => candidate.role === role);
        const assetData = ref ? assetsById.get(ref.assetId) : undefined;
        if (!ref || assetData === undefined) continue;
        const location = record(record(assetData).location);
        const body = record(assetData).body;
        if (
          location.kind !== "database" || typeof body !== "string"
        ) continue;
        const value = ref.kind === "json" || jsonMediaType(ref.mediaType)
          ? JSON.parse(body)
          : body;
        const replacement = await prepareRole(
          execution.namespace,
          threadId,
          execution.id,
          role,
          value,
        );
        if (!replacement.prepared || replacement.extractedAssets === 0) {
          continue;
        }
        report.extractedAssets += replacement.extractedAssets;
        for (const asset of replacement.prepared.assets) {
          await insertPreparedAsset(transaction, schema, asset);
        }
        removedAssetIds.push(ref.assetId);
        refs = replaceRoles(refs, [replacement.prepared], new Set([role]));
        changed = true;
      }
      if (!changed) continue;
      await transaction.query(
        `UPDATE ${q(schema, "nodes")}
         SET data = jsonb_set(data, '{content}', $3::jsonb), updated_at = NOW()
         WHERE namespace = $1 AND id = $2 AND type = 'tool_execution'`,
        [execution.namespace, execution.id, json(refs)],
      );
      removedAssetIds.push(
        ...await syncAssetEdges(
          transaction,
          schema,
          execution.namespace,
          execution.id,
          refs,
        ),
      );
      report.deletedOrphanAssets += await deleteUnreferencedMigrationAssets(
        transaction,
        schema,
        execution.namespace,
        removedAssetIds,
      );
    }
    cursor = executions.rows.at(-1)!.id;
  }
}

/** Repairs legacy tool-authored messages inside an already-open schema transaction. */
export async function repairLegacyToolMessages(
  transaction: SqlExecutor,
  schema: string,
  options: Readonly<{ includeRawV1?: boolean }> = {},
): Promise<ToolMessageRepairReport> {
  const rows = await transaction.query<NodeRow>(
    `SELECT id, namespace, name, content, data, source_type, source_id,
       created_at, updated_at
     FROM ${q(schema, "nodes")}
     WHERE type = 'message' AND (
       data -> 'metadata' -> 'migratedFromV1' ->> 'senderType' = 'tool'
       ${options.includeRawV1 ? "OR data ->> 'senderType' = 'tool'" : ""}
     )
     ORDER BY created_at, id`,
  );
  const report: ToolMessageRepairReport = {
    candidateMessages: rows.rows.length,
    mergedExecutions: 0,
    synthesizedExecutions: 0,
    extractedAssets: 0,
    deletedMessages: 0,
    deletedDuplicateEvents: 0,
    deletedOrphanAssets: 0,
  };
  for (const sourceRow of rows.rows) {
    let row = sourceRow;
    const data = record(row.data);
    const threadId = messageThread(row, data);
    const thread = await transaction.query<{ namespace: string }>(
      `SELECT namespace FROM ${q(schema, "nodes")}
       WHERE id = $1 AND type = 'thread' LIMIT 1`,
      [threadId],
    );
    const threadNamespace = text(thread.rows[0]?.namespace);
    if (!threadNamespace) {
      throw new Error(
        `Legacy tool message '${row.id}' has no readable thread.`,
      );
    }
    if (row.namespace !== threadNamespace) {
      await transaction.query(
        `UPDATE ${q(schema, "nodes")} SET namespace = $2
         WHERE id = $1 AND type = 'message'`,
        [row.id, threadNamespace],
      );
      await transaction.query(
        `UPDATE ${q(schema, "edges")} SET namespace = $2
         WHERE source_node_id = $1 OR target_node_id = $1`,
        [row.id, threadNamespace],
      );
      row = { ...row, namespace: threadNamespace };
    }
    const parsed = oneToolCall(data, row.id);
    const baseMatches = await transaction.query<NodeRow>(
      `SELECT id, namespace, name, content, data, source_type, source_id,
         created_at, updated_at
       FROM ${q(schema, "nodes")}
       WHERE namespace = $1 AND type = 'tool_execution'
         AND data ->> 'threadId' = $2
         AND data ->> 'toolCallId' = $3
         AND COALESCE(data -> 'tool' ->> 'id', data ->> 'toolId') = $4
       ORDER BY created_at, id`,
      [row.namespace, threadId, parsed.toolCallId, parsed.toolId],
    );
    const matches = await narrowExecutionMatches(
      transaction,
      schema,
      row,
      data,
      parsed,
      baseMatches.rows,
    );
    if (matches.length > 1) {
      throw new Error(
        `Legacy tool message '${row.id}' matches ${matches.length} tool executions; migration refuses to guess.`,
      );
    }
    const matched = matches[0];
    const executionId = matched?.id ??
      `migration:tool_execution:${row.id}`;
    const existingData = record(matched?.data);
    const requestingParticipantId = await participantId(
      transaction,
      schema,
      row,
      data,
      [
        existingData.participantId,
        existingData.agentId,
        parsed.call.participantId,
        parsed.call.agentId,
      ],
    );
    const existingParticipantId = text(existingData.participantId);
    if (
      requestingParticipantId && existingParticipantId &&
      requestingParticipantId !== existingParticipantId
    ) {
      throw new Error(
        `Legacy tool message '${row.id}' conflicts with the matched execution participant.`,
      );
    }
    const existingContent = content(existingData.content);
    const argumentsValue = parsed.call.args ?? parsed.call.arguments ??
      await databaseContentValue(
        transaction,
        schema,
        row.namespace,
        existingContent,
        "tool.arguments",
      ) ?? {};
    const outputValue = parsed.call.output ?? await databaseContentValue(
      transaction,
      schema,
      row.namespace,
      existingContent,
      "tool.output",
    );
    const projectedOutputValue = parsed.call.projectedOutput ??
      await databaseContentValue(
        transaction,
        schema,
        row.namespace,
        existingContent,
        "tool.projected_output",
      );
    const errorValue = parsed.call.error ?? await databaseContentValue(
      transaction,
      schema,
      row.namespace,
      existingContent,
      "tool.error_detail",
    );
    const outputs = await Promise.all([
      prepareRole(
        row.namespace,
        threadId,
        executionId,
        "tool.arguments",
        argumentsValue,
      ),
      prepareRole(
        row.namespace,
        threadId,
        executionId,
        "tool.output",
        outputValue,
      ),
      prepareRole(
        row.namespace,
        threadId,
        executionId,
        "tool.projected_output",
        projectedOutputValue,
      ),
      prepareRole(
        row.namespace,
        threadId,
        executionId,
        "tool.error_detail",
        errorValue,
      ),
    ]);
    report.extractedAssets += outputs.reduce(
      (total, item) => total + item.extractedAssets,
      0,
    );
    const prepared = outputs.flatMap((item) =>
      item.prepared ? [item.prepared] : []
    );
    for (const batch of prepared) {
      for (const asset of batch.assets) {
        await insertPreparedAsset(transaction, schema, asset);
      }
    }
    const attachments = await legacyAttachmentRefs(
      transaction,
      schema,
      row,
      data,
    );
    const replacementContent = replaceRoles(
      existingContent,
      prepared,
      new Set([
        "tool.arguments",
        "tool.output",
        "tool.projected_output",
        "tool.error_detail",
      ]),
    );
    for (const attachment of attachments) {
      if (
        !replacementContent.some((ref) =>
          ref.role === "attachment" && ref.assetId === attachment.assetId
        )
      ) {
        replacementContent.push(attachment);
      }
    }
    const status =
      parsed.call.status === "failed" || parsed.call.status === "cancelled"
        ? parsed.call.status
        : "completed";
    const metadata = {
      ...record(existingData.metadata),
      migratedFromV1: {
        ...record(record(existingData.metadata).migratedFromV1),
        legacyToolMessageId: row.id,
        repairedBy: "copilotz.content-v2",
      },
    };
    if (matched) {
      await transaction.query(
        `UPDATE ${q(schema, "nodes")}
         SET data = $3::jsonb, updated_at = GREATEST(updated_at, $4::timestamptz)
         WHERE namespace = $1 AND id = $2 AND type = 'tool_execution'`,
        [
          row.namespace,
          executionId,
          json({
            ...existingData,
            participantId: text(existingData.participantId) ??
              requestingParticipantId ?? null,
            agentId: text(existingData.agentId) ?? requestingParticipantId ??
              null,
            status,
            content: replacementContent,
            historyVisibility: text(parsed.call.visibility) ??
              text(existingData.historyVisibility) ?? null,
            safeError: parsed.call.error === undefined
              ? existingData.safeError
              : {
                message: typeof parsed.call.error === "string"
                  ? parsed.call.error
                  : json(parsed.call.error),
              },
            finishedAt: text(existingData.finishedAt) ?? iso(row.updated_at),
            metadata,
          }),
          iso(row.updated_at),
        ],
      );
      report.mergedExecutions++;
    } else {
      await transaction.query(
        `INSERT INTO ${q(schema, "nodes")} (
           id, namespace, type, name, data, source_type, source_id,
           created_at, updated_at
         ) VALUES ($1, $2, 'tool_execution', $3, $4::jsonb,
           'tool_call', $5, $6::timestamptz, $7::timestamptz)`,
        [
          executionId,
          row.namespace,
          text(parsed.tool.name) ?? parsed.toolId,
          json({
            threadId,
            messageId: null,
            participantId: requestingParticipantId ?? null,
            agentId: requestingParticipantId ?? null,
            toolCallId: parsed.toolCallId,
            tool: parsed.tool,
            status,
            content: replacementContent,
            historyVisibility: text(parsed.call.visibility) ?? null,
            safeError: parsed.call.error === undefined ? null : {
              message: typeof parsed.call.error === "string"
                ? parsed.call.error
                : json(parsed.call.error),
            },
            startedAt: iso(row.created_at),
            finishedAt: iso(row.updated_at),
            metadata,
          }),
          JSON.stringify([threadId, parsed.toolCallId]),
          iso(row.created_at),
          iso(row.updated_at),
        ],
      );
      report.synthesizedExecutions++;
    }
    await transaction.query(
      `INSERT INTO ${q(schema, "edges")} (
         id, namespace, source_node_id, target_node_id, type, data, weight
       ) VALUES ($1, $2, $3, $4, 'has_tool_execution', '{}', 1)
       ON CONFLICT DO NOTHING`,
      [ulid(), row.namespace, threadId, executionId],
    );
    if (requestingParticipantId) {
      await transaction.query(
        `INSERT INTO ${q(schema, "edges")} (
           id, namespace, source_node_id, target_node_id, type, data, weight
         ) VALUES ($1, $2, $3, $4, 'performed_by', '{}', 1)
         ON CONFLICT DO NOTHING`,
        [ulid(), row.namespace, requestingParticipantId, executionId],
      );
    }
    const removedExecutionAssets = await syncAssetEdges(
      transaction,
      schema,
      row.namespace,
      executionId,
      replacementContent,
    );
    const oldAssets = await transaction.query<{ target_node_id: string }>(
      `SELECT target_node_id FROM ${q(schema, "edges")}
       WHERE namespace = $1 AND source_node_id = $2 AND type = 'has_asset'`,
      [row.namespace, row.id],
    );
    await transaction.query(
      `DELETE FROM ${q(schema, "edges")}
       WHERE namespace = $1 AND (source_node_id = $2 OR target_node_id = $2)`,
      [row.namespace, row.id],
    );
    const deletedEvents = await transaction.query<{ id: string }>(
      `DELETE FROM ${q(schema, "events")} event
       WHERE event.namespace = $1 AND event.type = 'message.created'
         AND (event.subject_id = $2 OR event.payload ->> 'messageId' = $2)
         AND event.metadata ->> 'migratedFromV1' = 'true'
         AND NOT EXISTS (
           SELECT 1 FROM ${q(schema, "event_deliveries")} delivery
           WHERE delivery.event_id = event.id
         ) RETURNING event.id`,
      [row.namespace, row.id],
    );
    report.deletedDuplicateEvents += deletedEvents.rows.length;
    await transaction.query(
      `DELETE FROM ${q(schema, "nodes")}
       WHERE namespace = $1 AND id = $2 AND type = 'message'`,
      [row.namespace, row.id],
    );
    report.deletedMessages++;
    await deleteOrphanedToolParticipant(
      transaction,
      schema,
      row.namespace,
      data,
      requestingParticipantId,
    );
    report.deletedOrphanAssets += await deleteUnreferencedMigrationAssets(
      transaction,
      schema,
      row.namespace,
      [
        ...oldAssets.rows.map((item) => item.target_node_id),
        ...removedExecutionAssets,
      ],
    );
  }
  await sanitizeExistingToolExecutionContent(transaction, schema, report);
  await transaction.query(
    `UPDATE ${q(schema, "nodes")}
     SET data = data - 'lastEventId' - 'lastEventPosition' - 'lastEventAt'
     WHERE type = 'thread'`,
  );
  await transaction.query(
    `WITH latest AS (
       SELECT DISTINCT ON (namespace, thread_id)
         namespace, thread_id, id, position, created_at
       FROM ${q(schema, "events")}
       WHERE thread_id IS NOT NULL
       ORDER BY namespace, thread_id, position DESC
     )
     UPDATE ${q(schema, "nodes")} thread
     SET data = thread.data || jsonb_build_object(
       'lastEventId', latest.id,
       'lastEventPosition', latest.position::text,
       'lastEventAt', latest.created_at
     )
     FROM latest
     WHERE thread.namespace = latest.namespace AND thread.id = latest.thread_id
       AND thread.type = 'thread'`,
  );
  return report;
}
