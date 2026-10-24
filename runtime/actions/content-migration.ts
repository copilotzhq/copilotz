/** Offline removal of execution-owned content. Drain the runtime before applying. */
import {
  createCoreTableNames,
  type SqlExecutor,
  type SqlSession,
} from "../events/index.ts";

const nodeKey = (namespace: string, id: string) =>
  JSON.stringify([namespace, id]);
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
export type ContentMigrationDecision = Readonly<
  & {
    namespace: string;
    assetId: string;
  }
  & (
    | {
      /** null explicitly permits collection with no surviving producer. */
      ownerId: string | null;
      ownerIds?: never;
    }
    | {
      /** Reviewed shared ownership, restricted to reported candidates. */
      ownerIds: string[];
      ownerId?: never;
    }
  )
>;

/** Validate both CLI JSON and direct callers without changing legacy canonical bytes. */
export function canonicalContentDecision(
  decision: ContentMigrationDecision,
): ContentMigrationDecision {
  if (
    !decision || typeof decision.namespace !== "string" ||
    typeof decision.assetId !== "string" ||
    (Object.hasOwn(decision, "ownerId") === Object.hasOwn(decision, "ownerIds"))
  ) {
    throw new TypeError(
      "Content migration decisions require exactly one of ownerId or ownerIds.",
    );
  }
  if (Object.hasOwn(decision, "ownerIds")) {
    const ids = decision.ownerIds;
    if (
      !Array.isArray(ids) || !ids.length || ids.some((id) =>
        typeof id !== "string" || !id.trim()
      ) || new Set(ids).size !== ids.length
    ) {
      throw new TypeError(
        "ownerIds requires at least one owner and no duplicates.",
      );
    }
    return {
      namespace: decision.namespace,
      assetId: decision.assetId,
      ownerIds: [...ids].sort(),
    };
  }
  if (decision.ownerId !== null && typeof decision.ownerId !== "string") {
    throw new TypeError(
      "Content migration decisions require an explicit owner or null.",
    );
  }
  return {
    namespace: decision.namespace,
    assetId: decision.assetId,
    ownerId: decision.ownerId!,
  };
}

/** Suggestions only: operators must review this template before applying it. */
export function contentDecisionTemplate(
  plan: { ownership: ContentMigrationReport },
): ContentMigrationDecision[] {
  return plan.ownership.assets.flatMap((asset): ContentMigrationDecision[] =>
    asset.classification === "ambiguous"
      ? [{
        namespace: asset.namespace,
        assetId: asset.assetId,
        ownerIds: [...new Set(asset.producers.map((p) => p.id))].sort(),
      }]
      : asset.classification === "unowned"
      ? [{ namespace: asset.namespace, assetId: asset.assetId, ownerId: null }]
      : []
  ).sort((a, b) =>
    JSON.stringify(a) < JSON.stringify(b)
      ? -1
      : JSON.stringify(a) > JSON.stringify(b)
      ? 1
      : 0
  );
}
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

function references(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) references(child, ids);
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.assetId === "string") ids.add(object.assetId);
    for (const child of Object.values(object)) references(child, ids);
  }
}

async function inspect(tx: SqlExecutor, schema: string) {
  const tables = createCoreTableNames(schema);
  const nodes: Node[] = [];
  const referenceIds = new Map<string, Set<string>>();
  const keys = (await tx.query<{ namespace: string; id: string }>(
    `SELECT namespace,id FROM ${tables.nodes} ORDER BY namespace,id`,
  )).rows;
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = (await tx.query<Node>(
      `SELECT n.id,n.namespace,n.type,n.name,n.data FROM ${tables.nodes} n
       JOIN jsonb_to_recordset($1::jsonb) AS k(namespace text,id text)
         ON n.namespace=k.namespace AND n.id=k.id ORDER BY n.namespace,n.id`,
      [JSON.stringify(keys.slice(start, start + 1000))],
    )).rows;
    for (const node of batch) {
      const ids = new Set<string>();
      references(node.data, ids);
      if (ids.size) referenceIds.set(nodeKey(node.namespace, node.id), ids);
      nodes.push({
        ...node,
        data: {
          ...(node.type === EXECUTION_OWNER
            ? { assetIds: node.data.assetIds }
            : {}),
          ...(node.type === "asset"
            ? { state: node.data.state, origin: node.data.origin }
            : {}),
        },
      });
    }
  }
  const execution = nodes.filter((node) => node.type === EXECUTION_OWNER);
  const executionIds = new Set(
    execution.map((node) => nodeKey(node.namespace, node.id)),
  );
  let executionEdges = 0;
  const domains = nodes.filter((node) =>
    node.type !== EXECUTION_OWNER && node.type !== "asset" &&
    node.type !== "protected_value"
  );
  const nodeByKey = new Map(
    nodes.map((node) => [nodeKey(node.namespace, node.id), node]),
  );
  const domainByKey = new Map(
    domains.map((node) => [nodeKey(node.namespace, node.id), node]),
  );
  const outgoing = new Map<string, string[]>();
  const owners = new Map<string, Set<string>>();
  let edgeAfter: string | undefined;
  while (true) {
    const edges = (await tx.query<Edge>(
      `SELECT id,namespace,source_node_id,target_node_id,type FROM ${tables.edges}
       ${edgeAfter === undefined ? "" : "WHERE id>$1"} ORDER BY id LIMIT 2000`,
      edgeAfter === undefined ? [] : [edgeAfter],
    )).rows;
    for (const edge of edges) {
      if (
        executionIds.has(nodeKey(edge.namespace, edge.source_node_id)) ||
        executionIds.has(nodeKey(edge.namespace, edge.target_node_id))
      ) executionEdges++;
      if (edge.type !== "has_asset") continue;
      const source = nodeKey(edge.namespace, edge.source_node_id);
      const target = nodeKey(edge.namespace, edge.target_node_id);
      const targets = outgoing.get(source) ?? [];
      targets.push(edge.target_node_id);
      outgoing.set(source, targets);
      if (domainByKey.has(source)) {
        const ids = owners.get(target) ?? new Set<string>();
        ids.add(source);
        owners.set(target, ids);
      }
    }
    if (edges.length < 2000) break;
    edgeAfter = edges.at(-1)!.id;
  }
  const referrers = new Map<string, Set<string>>();
  const order = new Map(
    domains.map((node, index) => [nodeKey(node.namespace, node.id), index]),
  );
  for (const node of domains) {
    const ids = referenceIds.get(nodeKey(node.namespace, node.id)) ??
      new Set<string>();
    for (const id of ids) {
      const key = nodeKey(node.namespace, id);
      const refs = referrers.get(key) ?? new Set<string>();
      refs.add(nodeKey(node.namespace, node.id));
      referrers.set(key, refs);
    }
  }
  const orderedNodes = (ids: Iterable<string>) =>
    [...ids]
      .sort((a, b) => order.get(a)! - order.get(b)!)
      .map((id) => domainByKey.get(id)!);
  const report: ContentMigrationReport = {
    executionOwners: execution.length,
    executionEdges,
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
      ...(outgoing.get(nodeKey(owner.namespace, owner.id)) ?? []),
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
    const key = nodeKey(item.namespace, item.assetId);
    const found = nodeByKey.get(key);
    const asset = found?.type === "asset" ? found : undefined;
    const owned = orderedNodes(owners.get(key) ?? []);
    const origin = asset?.data.origin as Producer | undefined;
    const candidateIds = new Set(referrers.get(key) ?? []);
    if (origin) {
      const originKey = nodeKey(item.namespace, origin.id);
      if (domainByKey.get(originKey)?.type === origin.type) {
        candidateIds.add(originKey);
      }
    }
    const candidates = owned.length ? owned : orderedNodes(candidateIds);
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
  return { tables, domains, owners, report };
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
    const { domains, owners, report } = await inspect(
      tx,
      schema,
    );
    if (!options.apply) return report;
    const assetKeys = new Set(
      report.assets.map((asset) => nodeKey(asset.namespace, asset.assetId)),
    );
    const domainByKey = new Map(
      domains.map((node) => [nodeKey(node.namespace, node.id), node]),
    );
    const assignments: Record<string, unknown>[] = [];
    async function flush() {
      if (!assignments.length) return;
      await tx.query(
        `INSERT INTO ${tables.edges}(id,namespace,source_node_id,target_node_id,type,data)
         SELECT id,namespace,owner,asset,'has_asset','{}'::jsonb
         FROM jsonb_to_recordset($1::jsonb) AS v(id text,namespace text,owner text,asset text)`,
        [JSON.stringify(assignments)],
      );
      assignments.length = 0;
    }
    const decisions = new Map<string, ContentMigrationDecision>();
    for (const supplied of options.decisions ?? []) {
      const decision = canonicalContentDecision(supplied);
      const key = JSON.stringify([decision.namespace, decision.assetId]);
      if (decisions.has(key)) {
        throw new Error(`Duplicate decision for ${decision.assetId}.`);
      }
      if (
        !assetKeys.has(nodeKey(decision.namespace, decision.assetId))
      ) {
        throw new Error(
          `Decision references an unrelated asset: ${decision.assetId}.`,
        );
      }
      decisions.set(key, decision);
    }
    for (const asset of report.assets) {
      const decision = decisions.get(nodeKey(asset.namespace, asset.assetId));
      if (
        asset.classification === "missing" ||
        (asset.classification === "ambiguous" && !decision)
      ) {
        throw new Error(
          `Resolve ${asset.classification} content before migration: ${asset.assetId}.`,
        );
      }
      let ownerIds: string[];
      if (decision?.ownerIds !== undefined) {
        const candidates = new Set(asset.producers.map((p) => p.id));
        if (decision.ownerIds.some((id) => !candidates.has(id))) {
          throw new Error(
            `Decision owner is not a candidate producer for ${asset.assetId}.`,
          );
        }
        ownerIds = decision.ownerIds;
      } else {
        // Legacy single-owner decisions retain their original semantics.
        if (asset.classification === "ambiguous") {
          throw new Error(
            `Resolve ambiguous content with ownerIds before migration: ${asset.assetId}.`,
          );
        }
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
        ownerIds = ownerId === null ? [] : [ownerId!];
      }
      for (const ownerId of ownerIds) {
        const key = nodeKey(asset.namespace, ownerId);
        if (!domainByKey.has(key)) {
          throw new Error(
            `Domain producer not found in asset namespace: ${ownerId}.`,
          );
        }
        if (owners.get(nodeKey(asset.namespace, asset.assetId))?.has(key)) {
          continue;
        }
        assignments.push({
          id: crypto.randomUUID(),
          namespace: asset.namespace,
          owner: ownerId,
          asset: asset.assetId,
        });
        report.assignedOwners++;
        if (assignments.length === 2000) await flush();
      }
    }
    await flush();
    // Composite foreign keys remove only edges in each deleted node's namespace.
    await tx.query(`DELETE FROM ${tables.nodes} WHERE type=$1`, [
      EXECUTION_OWNER,
    ]);
    report.removedNodes = report.executionOwners;
    report.removedEdges = report.executionEdges;
    return report;
  });
}
