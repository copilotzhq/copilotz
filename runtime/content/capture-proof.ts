/** Read-only verification over C's existing capture, adoption and body catalogs. */
import {
  contentStreamBodyId,
  contentStreamIncarnationId,
} from "../streams/body-identity.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { sameValue } from "../collections/equal.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createContentCatalog } from "./catalog.ts";
import { cloneContentRef } from "./input.ts";
import { createContentPreparer } from "./preparer.ts";
import type { AssetOrigin, ContentInput, ContentSequence } from "./types.ts";

export async function assertCapturedContent(
  options: Readonly<{
    transaction: SqlExecutor;
    databaseSchema: string;
    namespace: string;
    producer: string;
    deliveryId: string;
    parentOperationKey: string;
    captureKey: string;
    streamBodyPrefix: string;
    original: ContentInput | readonly ContentInput[];
    content: ContentSequence;
    origin: AssetOrigin;
  }>,
): Promise<(transaction: SqlExecutor) => Promise<void>> {
  const { transaction, databaseSchema, namespace } = options;
  const tables = createCoreTableNames(databaseSchema);
  const catalog = createContentCatalog(transaction, databaseSchema);
  const refused = (): never => {
    throw new Error("Parent content capture is unavailable.");
  };
  // Preparation hashes the already-retained input. It never opens stored bytes.
  const prepared = await createContentPreparer().prepare(options.original, {
    namespace,
    idempotencyKey: options.captureKey,
  });
  if (prepared.content.length !== options.content.length) refused();
  for (let index = 0; index < prepared.content.length; index++) {
    const expected = prepared.content[index];
    const actual = options.content[index];
    const candidate = prepared.assets.find((asset) =>
      asset.id === expected.assetId
    );
    const row = (await transaction.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ${tables.nodes} WHERE namespace=$1 AND id=$2 AND type='asset'`,
      [namespace, actual.assetId],
    )).rows[0];
    if (!row) refused();
    const asset = captureHostCommandJson(row.data) as Record<string, unknown>;
    if (
      asset.state !== "ready" || typeof asset.bodyId !== "string" ||
      asset.mediaType !== actual.mediaType
    ) refused();
    const body = await catalog.read(asset.bodyId as string);
    if (
      !body || body.namespace !== namespace || body.revocation !== "active" ||
      body.terminal?.outcome !== "completed" ||
      body.terminal.digest !== asset.digest ||
      body.terminal.length !== asset.byteLength
    ) refused();
    const retired = await transaction.query(
      `SELECT 1 FROM ${tables.content_copies} WHERE copy_key=$1 AND state IN ('retiring','retired') UNION ALL SELECT 1 FROM ${tables.owner_body_retirements} WHERE body_id=$1 AND backend_kind=$2 AND backend_id=$3`,
      [
        body!.copy.key,
        body!.copy.backendKind,
        body!.copy.backendKind === "database" ? "" : body!.copy.backendId,
      ],
    );
    if (retired.rows.length) refused();
    if (!candidate) {
      // Already-canonical parent input is an exact descriptor claim, not a new capture.
      if (!sameValue(cloneContentRef(expected), actual)) refused();
      continue;
    }
    const itemKey = await deriveWorkflowId(
      "capture-item",
      options.captureKey,
      String(index),
    );
    const semanticId =
      `capture:delivery:${options.deliveryId}:content.capture:${options.parentOperationKey}/${itemKey}`;
    const expectedBodyId = contentStreamBodyId(
      namespace,
      contentStreamIncarnationId(semanticId, body!.writerId),
      options.streamBodyPrefix,
    );
    if (body!.bodyId !== expectedBodyId) refused();
    const pendingRef = `pending:${expectedBodyId}`;
    const pending = await catalog.resolvePending(namespace, {
      type: "content.pending",
      pendingRef,
      mediaType: candidate.mediaType,
      byteLength: candidate.byteLength,
      digest: candidate.digest,
    }, transaction);
    const { assetId: _id, mediaType: _mediaType, ...reference } = expected;
    if (
      pending.producer !== options.producer ||
      pending.body.bodyId !== asset.bodyId ||
      pending.body.namespace !== namespace ||
      pending.body.revocation !== "active" ||
      !sameValue(pending.descriptor.reference, reference) ||
      !sameValue(pending.descriptor.asset.metadata, candidate.metadata ?? {}) ||
      asset.digest !== candidate.digest ||
      asset.byteLength !== candidate.byteLength ||
      asset.mediaType !== candidate.mediaType ||
      !sameValue(asset.metadata ?? {}, candidate.metadata ?? {}) ||
      !sameValue(actual, {
        ...reference,
        assetId: actual.assetId,
        mediaType: candidate.mediaType,
      })
    ) refused();
    const adoption =
      (await transaction.query<{ owner_id: string; asset_id: string }>(
        `SELECT owner_id,asset_id FROM ${tables.content_adoptions} WHERE namespace=$1 AND pending_ref=$2`,
        [namespace, pendingRef],
      )).rows[0];
    if (
      !adoption || adoption.asset_id !== actual.assetId ||
      !sameValue(JSON.parse(adoption.owner_id), options.origin)
    ) refused();
  }
  const ids = [...new Set(options.content.map((ref) => ref.assetId))].sort();
  const destination = options.origin;
  return async (executor) => {
    const owner = await executor.query(
      `SELECT id FROM ${tables.nodes} WHERE namespace=$1 AND id=$2 AND type=$3`,
      [namespace, destination.id, destination.type],
    );
    if (owner.rows.length !== 1) refused();
    const edges = await executor.query<{ target_node_id: string }>(
      `SELECT target_node_id FROM ${tables.edges} WHERE namespace=$1 AND source_node_id=$2 AND type='has_asset' ORDER BY target_node_id`,
      [namespace, destination.id],
    );
    if (!sameValue(edges.rows.map((row) => row.target_node_id).sort(), ids)) {
      refused();
    }
  };
}
