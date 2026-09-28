import type { EventMutationContext, EventStatement } from "../events/store.ts";
import { digestContent } from "../content/digest.ts";
import { actionContentSequences } from "./content.ts";
import type { ActionEventData, AnyActionDefinition } from "./types.ts";

const UNAVAILABLE = "Action input Asset is unavailable for durable retention.";
const CONFLICT =
  "Action content retention identity conflicts with existing data.";

/** What keeps an Action's input Assets alive for as long as its receipt. */
export type ActionInputRetention = Readonly<{
  namespace: string;
  actionId: string;
  actionRunId: string;
  /** Every input reference; each must name a ready Asset of that media type. */
  refs: readonly Readonly<{ assetId: string; mediaType: unknown }>[];
  /** The distinct Asset ids, sorted. */
  assetIds: readonly string[];
  ownerId: string;
  /** The `has_asset` edge from the owner to each Asset, in `assetIds` order. */
  edgeIds: readonly string[];
}>;

/** The retention an invoked receipt needs, or undefined when it needs none. */
export async function planActionInputRetention(
  namespace: string,
  action: AnyActionDefinition,
  data: ActionEventData,
): Promise<ActionInputRetention | undefined> {
  if (!action.content || data.status !== "invoked") return undefined;
  const refs = actionContentSequences(data.input, action.content)
    .flat() as Record<string, unknown>[];
  const assetIds = [...new Set(refs.map((ref) => String(ref.assetId)))].sort();
  if (!assetIds.length) return undefined;
  const hash = await digestContent(
    new TextEncoder().encode(JSON.stringify([namespace, data.actionRunId])),
  );
  const ownerId = `action-content:${hash}`;
  const edgeIds: string[] = [];
  for (const id of assetIds) {
    const edgeHash = await digestContent(
      new TextEncoder().encode(JSON.stringify([ownerId, id])),
    );
    edgeIds.push(`action-content-edge:${edgeHash}`);
  }
  return {
    namespace,
    actionId: data.actionId,
    actionRunId: data.actionRunId,
    refs: refs.map((ref) => ({
      assetId: String(ref.assetId),
      mediaType: ref.mediaType,
    })),
    assetIds,
    ownerId,
    edgeIds,
  };
}

/**
 * Retention as part of the receipt's own statement. The receipt is inserted
 * only when every input Asset is ready with its declared media type (and stays
 * locked until commit, so it cannot be collected first) and the owner's
 * identity is free or already holds these Assets. The owner node and its edges
 * are written with the receipt.
 */
export function composeActionInputRetention(
  retention: ActionInputRetention,
  tables: EventMutationContext["tables"],
  param: (value: unknown) => string,
): EventStatement<void> {
  const text = (value: string) => `${param(value)}::text`;
  const namespace = text(retention.namespace);
  const ids = `${param(retention.assetIds)}::text[]`;
  const owner = text(retention.ownerId);
  const wanted = `${
    param(JSON.stringify(
      retention.refs.map((ref) => ({
        id: ref.assetId,
        media_type: typeof ref.mediaType === "string" ? ref.mediaType : null,
      })),
    ))
  }::jsonb`;
  return {
    ctes: [
      `retention_wanted AS (
         SELECT * FROM jsonb_to_recordset(${wanted})
           AS wanted(id text, media_type text)
       )`,
      `retention_assets AS (
         SELECT id, data FROM ${tables.nodes}
          WHERE namespace = ${namespace} AND type = 'asset' AND id = ANY(${ids})
          ORDER BY id FOR UPDATE
       )`,
      `retention_owner AS (
         SELECT namespace, type, source_id, data FROM ${tables.nodes}
          WHERE id = ${owner}
       )`,
      `retention_state AS (
         SELECT NOT EXISTS (
                  SELECT 1 FROM retention_wanted AS wanted
                  LEFT JOIN retention_assets AS asset ON asset.id = wanted.id
                  WHERE asset.id IS NULL
                     OR asset.data->>'state' IS DISTINCT FROM 'ready'
                     OR asset.data->>'mediaType' IS DISTINCT FROM wanted.media_type
                ) AS assets_ok,
                (NOT EXISTS (SELECT 1 FROM retention_owner)
                 OR EXISTS (
                      SELECT 1 FROM retention_owner AS existing
                      WHERE existing.namespace = ${namespace}
                        AND existing.type = '@copilotz/action-content'
                        AND existing.source_id = ${text(retention.actionRunId)}
                        AND existing.data->'assetIds' = ${
        param(JSON.stringify(retention.assetIds))
      }::jsonb
                    )) AS owner_ok
       )`,
    ],
    gate: "(SELECT assets_ok AND owner_ok FROM retention_state)",
    effects: (source) => [
      `retention_node AS (
         INSERT INTO ${tables.nodes} (
           id, namespace, type, name, data, source_type, source_id
         )
         SELECT ${owner}, ${namespace}, '@copilotz/action-content',
                ${text(retention.actionId)},
                ${
        param(JSON.stringify({ assetIds: retention.assetIds }))
      }::jsonb,
                'action', ${text(retention.actionRunId)}
           FROM ${source}
         ON CONFLICT DO NOTHING
       )`,
      `retention_edges AS (
         INSERT INTO ${tables.edges} (
           id, namespace, source_node_id, target_node_id, type, data, weight
         )
         SELECT held.edge_id, ${namespace}, ${owner}, held.asset_id,
                'has_asset', '{}'::jsonb, 1
           FROM ${source}, unnest(
                  ${param(retention.edgeIds)}::text[], ${ids}
                ) AS held(edge_id, asset_id)
         ON CONFLICT DO NOTHING
       )`,
    ],
    report:
      "jsonb_build_object('assetsOk', (SELECT assets_ok FROM retention_state), 'ownerOk', (SELECT owner_ok FROM retention_state))",
    resolve: (report, inserted) => {
      if (inserted) return;
      const state =
        (typeof report === "string" ? JSON.parse(report) : report) as
          | { assetsOk?: boolean; ownerOk?: boolean }
          | null;
      if (state?.assetsOk === false) throw new Error(UNAVAILABLE);
      if (state?.ownerOk === false) throw new Error(CONFLICT);
    },
  };
}

/**
 * Retention inside a transaction, statement by statement. It remains for a
 * receipt that also seals protected values, which are adopted in code.
 */
export async function retainActionInputContent(
  context: EventMutationContext,
  retention: ActionInputRetention,
): Promise<void> {
  const { namespace, assetIds: ids, ownerId } = retention;
  const assets = await context.transaction.query<
    { id: string; data: Record<string, unknown> }
  >(
    `SELECT id, data FROM ${context.tables.nodes}
     WHERE namespace = $1 AND type = 'asset' AND id = ANY($2::text[])
     ORDER BY id FOR UPDATE`,
    [namespace, ids],
  );
  const byId = new Map(assets.rows.map((row) => [row.id, row.data]));
  for (const ref of retention.refs) {
    const asset = byId.get(ref.assetId);
    if (
      !asset || asset.state !== "ready" || asset.mediaType !== ref.mediaType
    ) {
      throw new Error(UNAVAILABLE);
    }
  }
  await context.transaction.query(
    `INSERT INTO ${context.tables.nodes} (id,namespace,type,name,data,source_type,source_id)
     VALUES ($1,$2,'@copilotz/action-content',$3,$4::jsonb,'action',$5)
     ON CONFLICT DO NOTHING`,
    [
      ownerId,
      namespace,
      retention.actionId,
      JSON.stringify({ assetIds: ids }),
      retention.actionRunId,
    ],
  );
  const owner = await context.transaction.query<
    {
      namespace: string;
      type: string;
      source_id: string;
      data: { assetIds: string[] };
    }
  >(
    `SELECT namespace,type,source_id,data FROM ${context.tables.nodes} WHERE id = $1`,
    [ownerId],
  );
  const stored = owner.rows[0];
  if (
    !stored || stored.namespace !== namespace ||
    stored.type !== "@copilotz/action-content" ||
    stored.source_id !== retention.actionRunId ||
    JSON.stringify(stored.data.assetIds) !== JSON.stringify(ids)
  ) {
    throw new Error(CONFLICT);
  }
  for (const [index, id] of ids.entries()) {
    await context.transaction.query(
      `INSERT INTO ${context.tables.edges} (id,namespace,source_node_id,target_node_id,type,data,weight)
       VALUES ($1,$2,$3,$4,'has_asset','{}'::jsonb,1) ON CONFLICT DO NOTHING`,
      [retention.edgeIds[index], namespace, ownerId, id],
    );
  }
}
