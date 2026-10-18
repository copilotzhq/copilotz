/** Private present-state compatibility check for a bounded ordinary graph.
 *
 * The caller must inventory every raw node/edge in the exact schema under its
 * current owner fence, sharing its aggregate row/byte budget with history and
 * obligations. These arrays are already bounded and hydrated by that scanner;
 * this helper never queries, maps, normalizes, repairs or grants readiness.
 * Physical graph catalog validation and an independent final scan remain
 * separate gates. Registry membership is not namespace ownership or authority.
 * Blocker refs are snapshot-local diagnostics, not durable reconciliation keys;
 * callers must coalesce them under a stable graph-level alarm identity.
 */
import type { CollectionDefinition } from "../collections/definition.ts";
import { addFormats, Ajv } from "../../dependencies/ajv.ts";
import {
  type CollectionOrdinaryProjection,
  describeCollectionOrdinaryProjection,
  edgeId,
} from "../collections/ordinary-projection.ts";
import { validateEventSchemaName } from "../events/schema.ts";
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";

type Row = Readonly<Record<string, unknown>>;
type Definition = Pick<
  CollectionDefinition,
  | "name"
  | "schema"
  | "timestamps"
  | "identity"
  | "search"
  | "relations"
  | "indexes"
  | "content"
>;
type Captured = Readonly<{ definition?: Definition; snapshot: Definition }>;
export type OwnerCollectionGraphBlocker = Readonly<{
  kind: "blocker";
  namespace: string | null;
  /** Bounded snapshot-local reference; never raw record data or authority. */
  id: string;
  reason: string;
}>;
export type OwnerCollectionGraphValidation = Readonly<{
  nodes: number;
  edges: number;
  /** Retained descriptors, targets, edges, domains and blockers to charge to
   * the caller's remaining aggregate inventory budget. Raw rows were charged
   * before calling. No partial result is returned if this budget runs out. */
  derivedItems: number;
  /** Conservative preallocation reservation, charged to the same scanner. */
  derivedBytes: number;
  blockers: readonly OwnerCollectionGraphBlocker[];
}>;
const definitionFields = [
  "name",
  "schema",
  "timestamps",
  "identity",
  "search",
  "relations",
  "indexes",
  "content",
] as const;
const nodeFields = [
  "id",
  "namespace",
  "type",
  "name",
  "content",
  "data",
  "source_type",
  "source_id",
  "created_at",
  "updated_at",
] as const;
const edgeFields = [
  "id",
  "namespace",
  "source_node_id",
  "target_node_id",
  "type",
  "data",
  "weight",
  "created_at",
] as const;
const maxRows = 10_000;
const maxDefinitionBytes = 1024 * 1024;
const maxRawBytes = 32 * 1024 * 1024;
const incompatibleErrors = new WeakSet<Error>();
function reject(reason: string): never {
  const error = Object.assign(new Error(reason), {
    code: "owner_graph_incompatible",
  });
  incompatibleErrors.add(error);
  throw error;
}
function incomplete(): never {
  throw Object.assign(new Error("Owner graph inventory is incomplete."), {
    code: "owner_graph_inventory_incomplete",
  });
}
function canonical(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 1024 && value.trim() === value;
}
function identity(value: unknown): asserts value is string {
  if (!canonical(value)) reject("graph_identity");
}
/** Inspect only inert own data. In particular, do not invoke definition hooks
 * or getters while deciding which declarative fields to capture. */
function own(value: unknown): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject("graph_object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject("graph_object");
  }
  if (Object.getOwnPropertySymbols(value).length) reject("graph_object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 20_000) incomplete();
  return descriptors;
}
function inert(
  value: unknown,
  fields?: readonly string[],
): Record<string, unknown> {
  const descriptors = own(value);
  if (
    fields && (
      Object.keys(descriptors).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(descriptors, field))
    )
  ) reject("graph_row_shape");
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      reject("graph_accessor");
    }
  }
  return value as Record<string, unknown>;
}
function ordinary(value: unknown): boolean {
  try {
    assertOwnerOrdinaryValue(value);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { code?: unknown }).code === "ordinary_value_unsupported"
    ) return false;
    throw error;
  }
}
/** Strings are essential: a driver Date may already have discarded stored
 * microseconds. The caller must hydrate graph timestamps losslessly. This
 * first subset accepts ISO/SQL dates with explicit zones and at most 6 digits. */
function instant(value: unknown): bigint {
  if (typeof value !== "string") reject("graph_timestamp");
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/
      .exec(value);
  if (!match) reject("graph_timestamp");
  const [, year, month, day, hour, minute, second, fraction = "", offset] =
    match;
  const values = [year, month, day, hour, minute, second].map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(values[0], values[1] - 1, values[2]);
  if (
    values[0] < 1 || calendar.getUTCFullYear() !== values[0] ||
    calendar.getUTCMonth() !== values[1] - 1 ||
    calendar.getUTCDate() !== values[2] ||
    values[3] > 23 || values[4] > 59 || values[5] > 59
  ) reject("graph_timestamp");
  const zone = offset === "Z"
    ? "Z"
    : offset.length === 3
    ? `${offset}:00`
    : offset.includes(":")
    ? offset
    : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const milliseconds = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`,
  );
  if (!Number.isFinite(milliseconds)) reject("graph_timestamp");
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, "0"));
}
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}
/** Conservative serialized-string reservation, before calling the shared
 * descriptor. Repeated search fields and JSON-escaped edge IDs are charged
 * repeatedly; this never allocates the amplified projection to size it. */
function projectionBytes(
  definition: Definition,
  value: Record<string, unknown>,
  rawBytes: number,
  charge: (bytes: number) => void,
): void {
  charge(2 * rawBytes + 512);
  for (
    const field of ["id", "namespace", "name", definition.identity?.sourceField]
  ) {
    if (field && typeof value[field] === "string") {
      charge(6 * (value[field] as string).length + 32);
    }
  }
  if (definition.search?.enabled) {
    for (const field of definition.search.fields) {
      const part = value[field];
      if (typeof part === "string") charge(6 * part.length + 2);
    }
  }
  for (const [name, relation] of Object.entries(definition.relations ?? {})) {
    const raw = value[relation.foreignKey];
    if (
      (relation.type === "hasMany" || relation.type === "hasOne") &&
      !Object.hasOwn(value, relation.foreignKey)
    ) continue;
    const type = relation.edgeType ??
      `has_${
        relation.type === "belongsTo" ? definition.name : relation.collection
      }`;
    const common = (value.namespace as string).length +
      (value.id as string).length + type.length + relation.collection.length +
      name.length;
    charge(24 * common + 512);
    const targets = Array.isArray(raw)
      ? raw
      : raw === undefined || raw === null || raw === ""
      ? []
      : [raw];
    for (const target of targets) {
      charge(24 * (common + (target as string).length) + 512);
    }
  }
}
/** Detached declarative capture has its own aggregate structural budget. This
 * contains no protocol marker list: the shared ordinary guard alone classifies
 * reserved content/protected values after capture has proved inert JSON. */
function declarativeCopy(
  value: unknown,
  budget: { nodes: number; text: number },
  depth = 0,
): unknown {
  if (++budget.nodes > 20_000 || depth > 32) incomplete();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject("graph_definition_shape");
    return value;
  }
  if (typeof value === "string") {
    budget.text += value.length;
    if (budget.text > maxDefinitionBytes) incomplete();
    return value;
  }
  if (!value || typeof value !== "object") reject("graph_definition_shape");
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length
    ) reject("graph_definition_shape");
    const descriptors: Record<string, PropertyDescriptor> = Object
      .getOwnPropertyDescriptors(value);
    const length = descriptors.length.value;
    if (
      !Number.isSafeInteger(length) || length < 0 || length > 20_000 ||
      Object.keys(descriptors).length !== length + 1
    ) reject("graph_definition_shape");
    const copy: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        reject("graph_definition_accessor");
      }
      copy.push(declarativeCopy(descriptor.value, budget, depth + 1));
    }
    return copy;
  }
  const descriptors = own(value);
  const copy: Record<string, unknown> = Object.create(null);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      reject("graph_definition_accessor");
    }
    budget.text += name.length;
    if (budget.text > maxDefinitionBytes) incomplete();
    copy[name] = declarativeCopy(descriptor.value, budget, depth + 1);
  }
  return copy;
}
function validateIndexes(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 128) {
    reject("graph_definition_shape");
  }
  for (const declaration of value) {
    const spec = typeof declaration === "string" || Array.isArray(declaration)
      ? { fields: declaration }
      : inert(declaration);
    if (
      Object.keys(spec).some((field) =>
        !["fields", "unique", "type"].includes(field)
      )
    ) reject("graph_definition_shape");
    const fields = typeof spec.fields === "string"
      ? [spec.fields]
      : spec.fields;
    if (
      !Array.isArray(fields) || !fields.length || fields.length > 128 ||
      new Set(fields).size !== fields.length ||
      (spec.unique !== undefined && typeof spec.unique !== "boolean") ||
      (spec.type !== undefined &&
        !["btree", "gin", "brin"].includes(spec.type as string)) ||
      (spec.unique === true && spec.type !== undefined && spec.type !== "btree")
    ) reject("graph_definition_shape");
    for (const field of fields) identity(field);
  }
}
function supportedKind(value: string): boolean {
  return /^[a-z][a-z0-9_.-]*$/i.test(value) &&
    value !== "asset" && value !== "protected_value";
}
function hasAsyncSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    (key === "$async" && child !== false) || hasAsyncSchema(child)
  );
}
function capture(
  definitions: readonly CollectionDefinition[],
): Map<string, Captured> {
  if (!Array.isArray(definitions) || definitions.length > 256) incomplete();
  const captured = new Map<string, Captured>();
  let bytes = 0;
  const budget = { nodes: 0, text: 0 };
  for (const definition of definitions) {
    const descriptors = own(definition);
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const field of definitionFields) {
      const descriptor = descriptors[field];
      if (!descriptor) continue;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        reject("graph_definition_accessor");
      }
      // An explicitly absent optional declaration is not a JSON value.
      if (descriptor.value !== undefined) snapshot[field] = descriptor.value;
    }
    identity(snapshot.name);
    const name = snapshot.name;
    if (captured.has(name)) reject("graph_definition_ambiguous");
    const copied = declarativeCopy(snapshot, budget) as Record<string, unknown>;
    bytes += new TextEncoder().encode(JSON.stringify(copied)).byteLength;
    if (bytes > maxDefinitionBytes) incomplete();
    inert(copied.schema);
    for (
      const field of [
        "timestamps",
        "identity",
        "search",
        "relations",
        "content",
      ]
    ) {
      if (copied[field] !== undefined) inert(copied[field]);
    }
    let supported = supportedKind(name) && ordinary(copied) &&
      !hasAsyncSchema(copied.schema);
    if (copied.timestamps) {
      const timestamps = copied.timestamps as Row;
      if (
        Object.keys(timestamps).some((key) =>
          !["createdAt", "updatedAt"].includes(key)
        )
      ) {
        reject("graph_definition_shape");
      }
      for (const field of Object.values(timestamps)) identity(field);
    }
    if (copied.identity) {
      const declared = inert(copied.identity, ["sourceType", "sourceField"]);
      identity(declared.sourceType);
      identity(declared.sourceField);
    }
    if (copied.search) {
      const search = inert(copied.search, ["enabled", "fields"]);
      if (
        typeof search.enabled !== "boolean" || !Array.isArray(search.fields) ||
        search.fields.length > 128
      ) {
        reject("graph_definition_shape");
      }
      for (const field of search.fields) identity(field);
    }
    if (copied.content) {
      const content = inert(copied.content, ["fields"]);
      if (!Array.isArray(content.fields) || content.fields.length > 128) {
        reject("graph_definition_shape");
      }
      for (const field of content.fields) identity(field);
      if (content.fields.length) supported = false;
    }
    validateIndexes(copied.indexes);
    const relations = (copied.relations ?? {}) as Row;
    if (Object.keys(relations).length > 128) incomplete();
    for (const [name, input] of Object.entries(relations)) {
      identity(name);
      const relation = inert(input);
      if (
        Object.keys(relation).some((field) =>
          !["type", "collection", "foreignKey", "edgeType", "edge"].includes(
            field,
          )
        )
      ) {
        supported = false;
      }
      identity(relation.collection);
      identity(relation.foreignKey);
      if (relation.edgeType !== undefined) identity(relation.edgeType);
      identity(relation.type);
      if (relation.edge !== undefined) identity(relation.edge);
      if (
        !["belongsTo", "hasOne", "hasMany"].includes(relation.type) ||
        (relation.edge !== undefined &&
          !["parent-to-child", "child-to-parent"].includes(relation.edge)) ||
        relation.edgeType === "has_asset" || !supportedKind(relation.collection)
      ) supported = false;
    }
    captured.set(name, {
      snapshot: copied as Definition,
      ...(supported ? { definition: copied as Definition } : {}),
    });
  }
  return captured;
}
/** Internal shared declarative capture for graph catalog validation. It returns
 * detached data-only definitions, including well-formed unsupported kinds so
 * their declared indexes are never silently omitted. No public barrel export. */
export function captureOwnerGraphCollections(
  definitions: readonly CollectionDefinition[],
): readonly CollectionDefinition[] {
  return [...capture(definitions).values()].map(({ snapshot }) =>
    snapshot as CollectionDefinition
  );
}
/** An isolated synchronous snapshot validator avoids the shared command
 * validator's process-wide $id registry and Promise-truthiness behavior. Its
 * options match the existing ordinary Collection validation settings, with
 * coercion/removal defaults made explicit. This does not fix the separate
 * shared validator or grant async schema execution anywhere else. */
function snapshotValidator(definitions: ReadonlyMap<string, Captured>) {
  // deno-lint-ignore no-explicit-any
  const instance = new (Ajv as any)({
    strict: false,
    allErrors: true,
    useDefaults: false,
    coerceTypes: false,
    removeAdditional: false,
  });
  // deno-lint-ignore no-explicit-any
  (addFormats as any)(instance);
  const keys = new Map<string, string>();
  for (const [name, { definition }] of definitions) {
    if (!definition) continue;
    const key = `urn:copilotz:owner-graph:collection:${name}`;
    // Distinct current schema IDs are required. Duplicate IDs fail closed in
    // this isolated registry, including equal schemas from distinct definitions.
    instance.addSchema(definition.schema, key);
    keys.set(name, key);
  }
  return (definition: Definition, value: Record<string, unknown>): void => {
    const validator = instance.getSchema(keys.get(definition.name));
    if (typeof validator !== "function" || validator.$async === true) {
      reject("graph_collection_unsupported");
    }
    const valid = validator(structuredClone(value));
    if (valid !== true) reject("graph_record_schema");
  };
}
/** Absent hasMany/hasOne declarations are read-side inverses. Explicit
 * hasMany null/scalars are outside this subset; [] is an active empty domain.
 * belongsTo absent/null/"" and hasOne null/"" are active empty domains. */
function validateSubset(
  definition: Definition,
  value: Record<string, unknown>,
): { domains: number; targets: number } {
  if (
    value.name !== undefined && value.name !== null &&
    typeof value.name !== "string"
  ) reject("graph_name");
  for (const timestamp of ["createdAt", "updatedAt"] as const) {
    const field = definition.timestamps?.[timestamp] ?? timestamp;
    if (!Object.hasOwn(value, field) || typeof value[field] !== "string") {
      reject("graph_timestamp");
    }
    instant(value[field]);
  }
  if (definition.identity) {
    const raw = value[definition.identity.sourceField];
    if (raw !== undefined && raw !== null && raw !== "") identity(raw);
  }
  let domains = 0, targets = 0;
  for (const relation of Object.values(definition.relations ?? {})) {
    const present = Object.hasOwn(value, relation.foreignKey);
    const raw = value[relation.foreignKey];
    if (relation.type === "hasMany") {
      if (!present) continue;
      if (!Array.isArray(raw)) reject("graph_relation_value");
      if (new Set(raw).size !== raw.length) reject("graph_relation_value");
      for (const id of raw) identity(id);
      targets += raw.length;
    } else {
      if (relation.type === "hasOne" && !present) continue;
      if (raw !== undefined && raw !== null && raw !== "") {
        identity(raw);
        targets++;
      }
    }
    domains++;
  }
  return { domains, targets };
}

type Accepted = {
  row: Row;
  definition: Definition;
  projection: CollectionOrdinaryProjection;
  index: number;
};

export function validateOwnerCollectionGraph(
  options: Readonly<{
    ownerId: string;
    schema: string;
    /** Trusted configured coverage for this owner/schema, never inferred from
     * graph rows, Collection membership, requests or exposure maps. */
    namespaces: readonly string[];
    collections: readonly CollectionDefinition[];
    nodes: readonly Row[];
    edges: readonly Row[];
    /** Caller passes its remaining shared aggregate capacity, not a new budget. */
    maxDerivedItems: number;
    maxDerivedBytes: number;
    maxBlockers?: number;
  }>,
): OwnerCollectionGraphValidation {
  identity(options.ownerId);
  identity(options.schema);
  validateEventSchemaName(options.schema);
  if (
    !Array.isArray(options.namespaces) || options.namespaces.length > 1024 ||
    !Array.isArray(options.nodes) || !Array.isArray(options.edges) ||
    options.nodes.length + options.edges.length > maxRows ||
    !Number.isSafeInteger(options.maxDerivedItems) ||
    options.maxDerivedItems < 0 || options.maxDerivedItems > maxRows ||
    !Number.isSafeInteger(options.maxDerivedBytes) ||
    options.maxDerivedBytes < 0 || options.maxDerivedBytes > maxRawBytes
  ) incomplete();
  const maxBlockers = options.maxBlockers ?? 100;
  if (
    !Number.isSafeInteger(maxBlockers) || maxBlockers < 1 || maxBlockers > 1000
  ) incomplete();
  const namespaces = new Set<string>();
  for (const namespace of options.namespaces) {
    identity(namespace);
    if (namespaces.has(namespace)) reject("graph_namespace_ambiguous");
    namespaces.add(namespace);
  }
  const definitions = capture(options.collections);
  const validateRecord = snapshotValidator(definitions);
  const blockers: OwnerCollectionGraphBlocker[] = [];
  let derivedItems = 0, derivedBytes = 0, retainedBytes = 0;
  const charge = (count: number) => {
    derivedItems += count;
    if (derivedItems > options.maxDerivedItems) incomplete();
  };
  const chargeBytes = (bytes: number) => {
    derivedBytes += bytes;
    if (
      !Number.isSafeInteger(derivedBytes) ||
      derivedBytes > options.maxDerivedBytes
    ) incomplete();
  };
  const block = (
    kind: "node" | "edge",
    index: number,
    namespace: unknown,
    reason: string,
  ) => {
    charge(1);
    chargeBytes(512 + (canonical(namespace) ? namespace.length * 6 : 0));
    if (blockers.length >= maxBlockers) incomplete();
    blockers.push({
      kind: "blocker",
      namespace: canonical(namespace) ? namespace : null,
      id: `graph:${kind}:${index}`,
      reason,
    });
  };
  const ordinaryData = (
    value: unknown,
  ): { data: Record<string, unknown>; bytes: number } => {
    if (!ordinary(value)) reject("graph_nonordinary_value");
    const data = inert(value);
    const bytes = utf8Bytes(JSON.stringify(data));
    retainedBytes += bytes;
    if (retainedBytes > maxRawBytes) incomplete();
    return { data, bytes };
  };
  const nodes = new Map<string, Accepted>();
  const rawIds = new Set<string>();
  const identities = new Set<string>();
  for (const [index, input] of options.nodes.entries()) {
    let namespace: unknown;
    try {
      const row = inert(input, nodeFields);
      namespace = row.namespace;
      identity(row.id);
      identity(row.namespace);
      identity(row.type);
      if (rawIds.has(row.id)) reject("graph_duplicate_node");
      rawIds.add(row.id);
      if (!namespaces.has(row.namespace)) reject("graph_namespace");
      const definition = definitions.get(row.type)?.definition;
      if (!definition) reject("graph_collection_unsupported");
      const { data, bytes } = ordinaryData(row.data);
      if (
        !Object.hasOwn(data, "id") || !Object.hasOwn(data, "namespace") ||
        data.id !== row.id || data.namespace !== row.namespace
      ) reject("graph_record_identity");
      const expansion = validateSubset(definition, data);
      // Reserve before materializing the descriptor's copied arrays and strings.
      charge(1 + expansion.domains + 2 * expansion.targets);
      projectionBytes(definition, data, bytes, chargeBytes);
      validateRecord(definition, data);
      const projection = describeCollectionOrdinaryProjection(
        definition,
        data as Record<string, unknown> & { id: string; namespace: string },
      );
      if (projection.keys.length !== expansion.domains) {
        reject("graph_relation_ambiguous");
      }
      if (
        row.name !== projection.node.name ||
        row.content !== projection.node.content
      ) reject("graph_search_projection");
      if (
        row.source_type !== projection.node.sourceType ||
        row.source_id !== projection.node.sourceId
      ) reject("graph_source_projection");
      if (row.source_type !== null) {
        identity(row.source_type);
        identity(row.source_id);
        const key = JSON.stringify([
          row.namespace,
          row.type,
          row.source_type,
          row.source_id,
        ]);
        if (identities.has(key)) reject("graph_duplicate_identity");
        identities.add(key);
      }
      if (
        instant(row.created_at) !== instant(projection.node.createdAt) ||
        instant(row.updated_at) !== instant(projection.node.updatedAt)
      ) reject("graph_timestamp_projection");
      nodes.set(row.id, { row, definition, projection, index });
    } catch (error) {
      if (!(error instanceof Error) || !incompatibleErrors.has(error)) {
        throw error;
      }
      block("node", index, namespace, error.message);
    }
  }
  // A domain fixes one endpoint, edge type, and both endpoint kinds. Opposing
  // active domains with these same kinds overlap even when their present
  // foreign-key arrays are empty or disagree. No last-writer inference is safe.
  const domains = new Map<string, { source: Accepted[]; target: Accepted[] }>();
  const expected = new Map<
    string,
    { namespace: string; source: string; target: string; type: string }
  >();
  for (const node of nodes.values()) {
    const namespace = node.row.namespace as string;
    for (const key of node.projection.keys) {
      if (!definitions.get(key.related_type)?.definition) {
        block("node", node.index, namespace, "graph_relation_collection");
      }
      const sourceType = key.self_is_source
        ? node.definition.name
        : key.related_type;
      const targetType = key.self_is_source
        ? key.related_type
        : node.definition.name;
      const domainKey = JSON.stringify([
        namespace,
        key.edge_type,
        sourceType,
        targetType,
      ]);
      const group = domains.get(domainKey) ?? { source: [], target: [] };
      group[key.self_is_source ? "source" : "target"].push(node);
      domains.set(domainKey, group);
    }
    for (const target of node.projection.targets) {
      const related = nodes.get(target.related_id);
      if (
        !related || related.row.namespace !== namespace ||
        related.row.type !== target.related_type
      ) {
        block("node", node.index, namespace, "graph_relation_target");
      }
    }
    for (const edge of node.projection.edges) {
      if (expected.has(edge.id)) {
        block("node", node.index, namespace, "graph_relation_ambiguous");
      }
      expected.set(edge.id, {
        namespace,
        source: edge.source_id,
        target: edge.target_id,
        type: edge.edge_type,
      });
    }
  }
  for (const group of domains.values()) {
    if (group.source.length && group.target.length) {
      for (const node of [...group.source, ...group.target]) {
        block(
          "node",
          node.index,
          node.row.namespace,
          "graph_relation_ambiguous",
        );
      }
    }
  }
  const actual = new Set<string>();
  let acceptedEdges = 0;
  for (const [index, input] of options.edges.entries()) {
    let namespace: unknown;
    try {
      const row = inert(input, edgeFields);
      namespace = row.namespace;
      identity(row.id);
      identity(row.namespace);
      identity(row.type);
      identity(row.source_node_id);
      identity(row.target_node_id);
      if (!namespaces.has(row.namespace)) reject("graph_namespace");
      if (actual.has(row.id)) reject("graph_duplicate_edge");
      actual.add(row.id);
      if (Object.keys(ordinaryData(row.data).data).length || row.weight !== 1) {
        reject("graph_edge_shape");
      }
      instant(row.created_at);
      const source = nodes.get(row.source_node_id),
        target = nodes.get(row.target_node_id);
      if (
        !source || !target || source.row.namespace !== row.namespace ||
        target.row.namespace !== row.namespace
      ) reject("graph_edge_endpoint");
      const wanted = expected.get(row.id);
      if (
        !wanted || wanted.namespace !== row.namespace ||
        wanted.source !== row.source_node_id ||
        wanted.target !== row.target_node_id || wanted.type !== row.type ||
        row.id !==
          edgeId(
            row.namespace,
            row.type,
            row.source_node_id,
            row.target_node_id,
          )
      ) reject("graph_edge_undeclared");
      acceptedEdges++;
    } catch (error) {
      if (!(error instanceof Error) || !incompatibleErrors.has(error)) {
        throw error;
      }
      block("edge", index, namespace, error.message);
    }
  }
  let missing = 0;
  for (const [id, edge] of expected) {
    if (!actual.has(id)) {
      block(
        "edge",
        options.edges.length + missing++,
        edge.namespace,
        "graph_edge_missing",
      );
    }
  }
  return {
    nodes: nodes.size,
    edges: acceptedEdges,
    derivedItems,
    derivedBytes,
    blockers,
  };
}
