/** Offline removal of execution-owned content. Drain the runtime before applying. */
import {
  createCoreTableNames,
  type SqlExecutor,
  type SqlSession,
} from "../runtime/events/index.ts";
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";

const EXECUTION_OWNER = "@copilotz/action-content";
type Node = {
  id: string;
  namespace: string;
  type: string;
  name: string;
  data: Record<string, unknown>;
};
type Edge = {
  id: string;
  namespace: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
};
type Producer = { id: string; type: string };
export type ContentMigrationDecision = Readonly<{
  namespace: string;
  assetId: string;
  /** null explicitly permits collection of content with no surviving producer. */
  ownerId: string | null;
}>;
export type ContentMigrationReport = {
  executionOwners: number;
  executionEdges: number;
  assets: {
    namespace: string;
    assetId: string;
    state: unknown;
    origin: unknown;
    consumers: string[];
    producers: Producer[];
    classification: "owned" | "producer" | "ambiguous" | "unowned" | "missing";
  }[];
  byProducer: Record<string, number>;
  removedNodes: number;
  removedEdges: number;
  assignedOwners: number;
};

function references(value: unknown, assetId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((child) => references(child, assetId));
  }
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (object.assetId === assetId) return true;
  return Object.values(object).some((child) => references(child, assetId));
}

async function inspect(tx: SqlExecutor, schema: string) {
  const tables = createCoreTableNames(schema);
  // This is deliberately an offline scan: provenance must be reviewed before deletion.
  const nodes = (await tx.query<Node>(
    `SELECT id, namespace, type, name, data FROM ${tables.nodes} ORDER BY namespace, id`,
  )).rows;
  const edges = (await tx.query<Edge>(
    `SELECT id, namespace, source_node_id, target_node_id, type FROM ${tables.edges} ORDER BY id`,
  )).rows;
  const execution = nodes.filter((node) => node.type === EXECUTION_OWNER);
  const executionIds = new Set(execution.map((node) => node.id));
  const executionEdges = edges.filter((edge) =>
    executionIds.has(edge.source_node_id) ||
    executionIds.has(edge.target_node_id)
  );
  const domains = nodes.filter((node) =>
    node.type !== EXECUTION_OWNER && node.type !== "asset" &&
    node.type !== "protected_value"
  );
  const report: ContentMigrationReport = {
    executionOwners: execution.length,
    executionEdges: executionEdges.length,
    assets: [],
    byProducer: {},
    removedNodes: 0,
    removedEdges: 0,
    assignedOwners: 0,
  };
  const referenced = new Map<
    string,
    { namespace: string; assetId: string; consumers: Set<string> }
  >();
  for (const owner of execution) {
    const ids = new Set([
      ...edges.filter((edge) =>
        edge.source_node_id === owner.id && edge.type === "has_asset"
      ).map((edge) => edge.target_node_id),
      ...(Array.isArray(owner.data.assetIds)
        ? owner.data.assetIds.filter((id): id is string =>
          typeof id === "string"
        )
        : []),
    ]);
    for (const assetId of ids) {
      const key = JSON.stringify([owner.namespace, assetId]);
      const item = referenced.get(key) ??
        { namespace: owner.namespace, assetId, consumers: new Set<string>() };
      item.consumers.add(owner.name);
      referenced.set(key, item);
    }
  }
  for (const item of referenced.values()) {
    const asset = nodes.find((node) =>
      node.id === item.assetId && node.namespace === item.namespace &&
      node.type === "asset"
    );
    const owned = domains.filter((node) =>
      node.namespace === item.namespace &&
      edges.some((edge) =>
        edge.namespace === item.namespace && edge.source_node_id === node.id &&
        edge.target_node_id === item.assetId && edge.type === "has_asset"
      )
    );
    const origin = asset?.data.origin as Producer | undefined;
    const candidates = owned.length
      ? owned
      : domains.filter((node) =>
        node.namespace === item.namespace && (
          (origin?.id === node.id && origin?.type === node.type) ||
          references(node.data, item.assetId)
        )
      );
    const classification = !asset
      ? "missing"
      : candidates.length > 1
      ? "ambiguous"
      : owned.length === 1
      ? "owned"
      : candidates.length === 1
      ? "producer"
      : "unowned";
    report.assets.push({
      namespace: item.namespace,
      assetId: item.assetId,
      state: asset?.data.state ?? null,
      origin: origin ?? null,
      consumers: [...item.consumers].sort(),
      producers: candidates.map(({ id, type }) => ({ id, type })),
      classification,
    });
    const group = candidates.length === 1 ? candidates[0].type : classification;
    report.byProducer[group] = (report.byProducer[group] ?? 0) + 1;
  }
  return { tables, nodes, edges, domains, executionIds, report };
}

/** Dry runs never mutate. Apply is atomic and refuses unresolved ownership. */
export function migrateActionContent(
  session: SqlSession,
  schema: string,
  options: {
    apply?: boolean;
    decisions?: readonly ContentMigrationDecision[];
  } = {},
): Promise<ContentMigrationReport> {
  return session.transaction(async (tx) => {
    const tables = createCoreTableNames(schema);
    if (options.apply) {
      await tx.query(
        `LOCK TABLE ${tables.nodes}, ${tables.edges} IN ACCESS EXCLUSIVE MODE`,
      );
      const active = await tx.query(
        `SELECT 1 FROM ${tables.event_deliveries} WHERE status IN ('pending', 'leased', 'retry_wait') UNION ALL SELECT 1 FROM ${tables.open_actions} LIMIT 1`,
      );
      if (active.rows.length) {
        throw new Error("Drain all execution before content migration.");
      }
    }
    const { nodes, edges, domains, executionIds, report } = await inspect(
      tx,
      schema,
    );
    if (!options.apply) return report;
    const decisions = new Map<string, ContentMigrationDecision>();
    for (const decision of options.decisions ?? []) {
      const key = JSON.stringify([decision.namespace, decision.assetId]);
      if (decisions.has(key)) {
        throw new Error(`Duplicate decision for ${decision.assetId}.`);
      }
      if (
        !report.assets.some((asset) =>
          asset.namespace === decision.namespace &&
          asset.assetId === decision.assetId
        )
      ) {
        throw new Error(
          `Decision references an unrelated asset: ${decision.assetId}.`,
        );
      }
      decisions.set(key, decision);
    }
    for (const asset of report.assets) {
      if (
        asset.classification === "missing" ||
        asset.classification === "ambiguous"
      ) {
        throw new Error(
          `Resolve ${asset.classification} content before migration: ${asset.assetId}.`,
        );
      }
      const decision = decisions.get(
        JSON.stringify([asset.namespace, asset.assetId]),
      );
      const inferred = asset.producers[0]?.id;
      if (decision && inferred && decision.ownerId !== inferred) {
        throw new Error(
          `Decision conflicts with producer for ${asset.assetId}.`,
        );
      }
      if (!inferred && !decision) {
        throw new Error(
          `Explicit owner or collection decision required for ${asset.assetId}.`,
        );
      }
      const ownerId = inferred ?? decision!.ownerId;
      if (ownerId === null) continue;
      const owner = domains.find((node) =>
        node.id === ownerId && node.namespace === asset.namespace
      );
      if (!owner) {
        throw new Error(
          `Domain producer not found in asset namespace: ${ownerId}.`,
        );
      }
      if (asset.classification === "owned") continue;
      await tx.query(
        `INSERT INTO ${tables.edges} (id, namespace, source_node_id, target_node_id, type, data) VALUES ($1,$2,$3,$4,'has_asset','{}'::jsonb)`,
        [crypto.randomUUID(), asset.namespace, ownerId, asset.assetId],
      );
      report.assignedOwners++;
    }
    const ids = [...executionIds];
    if (ids.length) {
      await tx.query(
        `DELETE FROM ${tables.edges} WHERE source_node_id = ANY($1::text[]) OR target_node_id = ANY($1::text[])`,
        [ids],
      );
      await tx.query(
        `DELETE FROM ${tables.nodes} WHERE id = ANY($1::text[]) AND type = $2`,
        [ids, EXECUTION_OWNER],
      );
    }
    report.removedNodes = nodes.filter((node) =>
      executionIds.has(node.id)
    ).length;
    report.removedEdges = edges.filter((edge) =>
      executionIds.has(edge.source_node_id) ||
      executionIds.has(edge.target_node_id)
    ).length;
    return report;
  });
}

if (import.meta.main) {
  const args = Deno.args;
  const schema = args.find((arg) => arg.startsWith("--schema="))?.slice(9);
  const decisionsPath = args.find((arg) => arg.startsWith("--decisions="))
    ?.slice(12);
  if (
    !schema ||
    args.some((arg) =>
      !arg.startsWith("--schema=") && !arg.startsWith("--decisions=") &&
      arg !== "--apply"
    )
  ) {
    throw new Error(
      "Usage: COPILOTZ_MIGRATION_DATABASE_URL=... deno run -A scripts/migrate-action-content.ts --schema=SCHEMA [--apply --decisions=FILE.json]",
    );
  }
  const url = Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL");
  if (!url) throw new Error("COPILOTZ_MIGRATION_DATABASE_URL is required.");
  const decisions = decisionsPath
    ? JSON.parse(await Deno.readTextFile(decisionsPath))
    : undefined;
  const database = await openManagedOminipgDatabase({ url });
  try {
    console.log(
      JSON.stringify(
        await migrateActionContent(database.session, schema, {
          apply: args.includes("--apply"),
          decisions,
        }),
        null,
        2,
      ),
    );
  } finally {
    await database.close();
  }
}
