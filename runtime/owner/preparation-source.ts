/** Private, current-authorized reader for the legacy database-backed content
 * layout. This neither captures a preparation nor implements F9 current-copy
 * migration. It is only a fixed owner projection over registered source fields.
 * Policy callbacks are trusted, transaction-local reads, never remote code. */
import type { CollectionDefinition } from "../collections/definition.ts";
import { declaredCollectionJsonField } from "../collections/field.ts";
import { getPath } from "../collections/content-path.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { actionSchemaHasSecrets } from "../actions/secret.ts";
import { PROTECTED_ACTION_LIFECYCLE_SCHEMA } from "../actions/protected-lifecycle.ts";
import { PROTECTED_VALUE_REF_SCHEMA } from "../actions/protected-value.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { digestContent } from "../content/digest.ts";
import { contentRefSchema } from "../content/schema.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { assertJsonValue } from "../json.ts";
import type {
  OwnerCaller,
  OwnerJson,
  OwnerProjectionHandler,
} from "./boundary.ts";

export type PreparationSourceRequest = Readonly<{
  source: string;
  recordId: string;
}>;
export type PreparationSourceScope = Readonly<{
  namespace: string;
  audience: string;
}>;
export type OwnerPreparationSourceOptions = Readonly<{
  ownerId: string;
  schema: string;
  sources: Readonly<
    Record<
      string,
      Readonly<{
        collection: CollectionDefinition;
        contentPath: string;
      }>
    >
  >;
  /** Must check the exact current parent/session/lease, owner and audience,
   * plus this source record's visibility/read constraints. Namespace membership
   * alone is insufficient. Called before source access and at the output gate. */
  authorize(
    tx: SqlExecutor,
    context: Readonly<{
      ownerId: string;
      caller: OwnerCaller;
      request: PreparationSourceRequest;
      commandTime: string;
    }>,
  ): PreparationSourceScope | Promise<PreparationSourceScope>;
  /** Mandatory field projection for this audience. There is no raw-record
   * fallback. Returned nested ContentRefs/locators/protected envelopes are
   * refused; selected content is returned only by the separately checked path. */
  projectRecord(
    record: Readonly<Record<string, OwnerJson>>,
    context: Readonly<{
      request: PreparationSourceRequest;
      scope: PreparationSourceScope;
    }>,
  ): OwnerJson | Promise<OwnerJson>;
  /** Aggregate source/body/output budget, enforced independently at each stage. */
  maxBytes?: number;
  maxReferences?: number;
}>;
export type OwnerPreparationSource = Readonly<{
  projections: Readonly<{ "preparation.source": OwnerProjectionHandler }>;
}>;

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    fail("preparation_invalid");
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("preparation_invalid");
  }
  return value as Record<string, unknown>;
}
function canonical(value: OwnerJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${
          canonical((value as Record<string, OwnerJson>)[key])
        }`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
const encoder = new TextEncoder();
function snapshot(value: unknown, maxBytes: number): OwnerJson {
  assertJsonValue(value, { maxDepth: 32, maxNodes: 20_000 });
  if (encoder.encode(JSON.stringify(value)).length > maxBytes) {
    fail("preparation_limit");
  }
  return structuredClone(value) as OwnerJson;
}
function plain(value: OwnerJson): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    const schema = (value as Record<string, OwnerJson>).schema;
    if (
      schema === PROTECTED_ACTION_LIFECYCLE_SCHEMA ||
      schema === PROTECTED_VALUE_REF_SCHEMA
    ) {
      fail("preparation_unsupported");
    }
    for (
      const key of [
        "assetId",
        "bodyId",
        "location",
        "$copilotz-secret",
        "$copilotz-protected",
      ]
    ) {
      if (Object.hasOwn(value, key)) fail("preparation_unsupported");
    }
  }
  for (const child of Object.values(value)) plain(child);
}
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > fallback) {
    fail("preparation_invalid");
  }
  return result;
}

export function createOwnerPreparationSource(
  options: OwnerPreparationSourceOptions,
): OwnerPreparationSource {
  const ownerId = text(options.ownerId);
  const tables = createCoreTableNames(options.schema);
  const schema = options.schema;
  const authorize = options.authorize;
  const projectRecord = options.projectRecord;
  const maxBytes = limit(options.maxBytes, 1_048_576);
  const maxReferences = limit(options.maxReferences, 100);
  const sources = new Map(
    Object.entries(options.sources).map(([name, source]) => {
      text(name);
      const collection = source.collection;
      const path = text(source.contentPath);
      const recordSchema = collection.schema;
      if (typeof recordSchema !== "object") fail("preparation_unsupported");
      declaredCollectionJsonField(collection, path);
      if (
        collection.name === "asset" ||
        !collection.content?.fields.includes(path) ||
        actionSchemaHasSecrets(recordSchema)
      ) fail("preparation_unsupported");
      return [name, {
        kind: text(collection.name),
        path,
        recordSchema: structuredClone(recordSchema),
      }] as const;
    }),
  );
  const read: OwnerProjectionHandler = async (input, context) => {
    context.signal.throwIfAborted();
    const raw = object(snapshot(input, maxBytes));
    if (
      Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "source") ||
      !Object.hasOwn(raw, "recordId")
    ) fail("preparation_invalid");
    const request = { source: text(raw.source), recordId: text(raw.recordId) };
    const source = sources.get(request.source);
    if (!source) fail("preparation_invalid");
    // Keep callback data detached from the private reference, source and caller.
    const caller = structuredClone(context.caller);
    const scopeNow = async (): Promise<PreparationSourceScope> => {
      context.signal.throwIfAborted();
      const value = object(snapshot(
        await authorize(context.tx, {
          ownerId,
          caller: structuredClone(caller),
          request: structuredClone(request),
          commandTime: context.commandTime,
        }),
        maxBytes,
      ));
      if (Object.keys(value).length !== 2) fail("preparation_invalid");
      const scope = {
        namespace: text(value.namespace),
        audience: text(value.audience),
      };
      context.signal.throwIfAborted();
      return scope;
    };
    const scope = await scopeNow();
    // Bound the raw JSON transferred from SQL as well as the later projection.
    const rows = await context.tx.query<{ data: unknown; bytes: number }>(
      `SELECT CASE WHEN octet_length(data::text) <= $4 THEN data END AS data,
        octet_length(data::text) AS bytes FROM ${tables.nodes}
       WHERE id=$1 AND namespace=$2 AND type=$3`,
      [request.recordId, scope.namespace, source.kind, maxBytes],
    );
    context.signal.throwIfAborted();
    if (!rows.rows.length) fail("content_missing");
    if (Number(rows.rows[0].bytes) > maxBytes) fail("preparation_limit");
    const data = object(snapshot(rows.rows[0].data, maxBytes));
    const record = snapshot({
      ...data,
      id: request.recordId,
      namespace: scope.namespace,
    }, maxBytes) as Record<string, OwnerJson>;
    validateAgainstJsonSchema(
      source.recordSchema,
      record,
      "Preparation source",
    );
    const selected = getPath(record, source.path);
    if (!Array.isArray(selected)) fail("preparation_invalid");
    if (selected.length > maxReferences) fail("preparation_limit");
    const projected = snapshot(
      await projectRecord(structuredClone(record), {
        request: structuredClone(request),
        scope: structuredClone(scope),
      }),
      maxBytes,
    );
    plain(projected);
    context.signal.throwIfAborted();
    const store = createDatabaseBodyStore({
      session: context.tx,
      schema,
      provisioned: true,
    });
    const content: { ref: OwnerJson; version: OwnerJson; value: OwnerJson }[] =
      [];
    let bytesRead = 0;
    for (const selectedRef of selected) {
      context.signal.throwIfAborted();
      validateAgainstJsonSchema(
        contentRefSchema,
        selectedRef,
        "Preparation content ref",
      );
      const ref = object(selectedRef);
      const assetId = text(ref.assetId);
      if (ref.kind !== "text" && ref.kind !== "json") {
        fail("preparation_unsupported");
      }
      const asset = await context.tx.query<{ data: unknown }>(
        `SELECT CASE WHEN octet_length(data::text) <= $3 THEN data END AS data
         FROM ${tables.nodes} WHERE id=$1 AND namespace=$2 AND type='asset'`,
        [assetId, scope.namespace, maxBytes],
      );
      if (!asset.rows.length) fail("content_missing");
      const body = object(snapshot(asset.rows[0].data, maxBytes));
      const owners = await context.tx.query<
        { source_node_id: string; namespace: string }
      >(
        `SELECT source_node_id, namespace FROM ${tables.edges}
         WHERE target_node_id=$1 AND type='has_asset' LIMIT 2`,
        [assetId],
      );
      if (
        owners.rows.length !== 1 ||
        owners.rows[0].source_node_id !== request.recordId ||
        owners.rows[0].namespace !== scope.namespace
      ) fail("preparation_forbidden");
      const location = object(body.location);
      if (location.kind !== "database") fail("preparation_unsupported");
      const bodyId = text(body.bodyId);
      if (location.key !== bodyId || body.state !== "ready") {
        fail("content_missing");
      }
      const byteLength = body.byteLength;
      if (
        !Number.isSafeInteger(byteLength) || (byteLength as number) < 0 ||
        typeof body.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(body.digest) ||
        body.mediaType !== ref.mediaType
      ) fail("content_corrupted");
      bytesRead += byteLength as number;
      if (bytesRead > maxBytes) fail("preparation_limit");
      const head = await store.head({ bodyId });
      if (!head) fail("content_missing");
      if (
        head.state !== "ready" || head.byteLength !== byteLength ||
        head.digest !== body.digest || head.mediaType !== ref.mediaType
      ) fail("content_corrupted");
      const bytes = await store.readRange({
        bodyId,
        offset: 0,
        end: byteLength as number,
      });
      if (
        bytes.byteLength !== byteLength ||
        await digestContent(bytes) !== body.digest
      ) {
        fail("content_corrupted");
      }
      let value: OwnerJson;
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        value = ref.kind === "json"
          ? snapshot(JSON.parse(decoded), maxBytes)
          : decoded;
      } catch {
        fail("content_corrupted");
      }
      plain(value);
      content.push({
        ref: {
          assetId,
          kind: ref.kind,
          role: text(ref.role),
          mediaType: text(ref.mediaType),
        },
        version: { byteLength: byteLength as number, digest: body.digest },
        value,
      });
      // Includes escaping/JSON expansion and repeated references, without truncation.
      snapshot({ record: projected, content }, maxBytes);
    }
    // The exported version binds only data this audience may see. Hashing the
    // raw record would expose low-entropy hidden fields through guess checking.
    const version = await digestContent(encoder.encode(canonical({
      source: request.source,
      kind: source.kind,
      recordId: request.recordId,
      namespace: scope.namespace,
      audience: scope.audience,
      record: projected,
      content: content.map(({ ref, version }) => ({ ref, version })),
    })));
    const output = snapshot({
      source: {
        name: request.source,
        kind: source.kind,
        recordId: request.recordId,
        namespace: scope.namespace,
        digest: version,
      },
      audience: scope.audience,
      record: projected,
      content,
    }, maxBytes);
    const current = await scopeNow();
    if (
      current.namespace !== scope.namespace ||
      current.audience !== scope.audience
    ) {
      fail("preparation_forbidden");
    }
    context.signal.throwIfAborted();
    return output;
  };
  return { projections: { "preparation.source": read } };
}
