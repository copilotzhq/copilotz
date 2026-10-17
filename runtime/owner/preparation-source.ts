/** Private, current-authorized reader for the legacy database-backed content
 * layout. This neither captures a preparation nor implements F9 current-copy
 * migration. It is only a fixed owner projection over registered source fields.
 * Policy callbacks are trusted, transaction-local reads, never remote code. */
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import { declaredCollectionJsonField } from "../collections/field.ts";
import { getPath } from "../collections/content-path.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { actionSchemaHasSecrets } from "../actions/secret.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import { digestContent } from "../content/digest.ts";
import { contentRefSchema } from "../content/schema.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { assertJsonValue } from "../json.ts";
import {
  parsePreparationSourceReference,
  type PreparationContentReference,
  type PreparationSourceReference,
} from "./preparation-capture.ts";
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
  /** Required for capture and original reuse, not for the read-only projection.
   * Must authorize the ENTIRE ORIGINAL projected value/content version for this
   * purpose, including field-level restrictions. Record visibility alone is not
   * sufficient; a digest is provenance, never permission. No current rerender or
   * reproject may substitute for this decision. Called before body reads and at
   * the output gate, with detached original facts. */
  authorizeReference?(
    tx: SqlExecutor,
    context: Readonly<
      {
        ownerId: string;
        caller: OwnerCaller;
        reference: PreparationSourceReference;
        purpose: "capture" | "duplicate" | "input" | "result";
        commandTime: string;
      }
    >,
  ): true | Promise<true>;
  /** Aggregate source/body/output budget, enforced independently at each stage. */
  maxBytes?: number;
  maxReferences?: number;
}>;
type SourceContext = Parameters<OwnerProjectionHandler>[1];
export type OwnerPreparationSource = Readonly<{
  /** Private owner-local capture facts; no new body or receipt is written. */
  capture(
    input: PreparationSourceRequest,
    context: SourceContext,
  ): Promise<
    Readonly<{ projection: OwnerJson; reference: PreparationSourceReference }>
  >;
  /** Reauthorize ORIGINAL captured refs without selecting today's content field
   * or projecting today's record. Only trusted captured event metadata may call
   * this method; it is deliberately absent from the wire projection table. */
  authorizeOriginal(
    reference: PreparationSourceReference,
    context: SourceContext,
    purpose: "capture" | "duplicate" | "input" | "result",
  ): Promise<void>;
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
  try {
    assertOwnerOrdinaryValue(value);
  } catch (error) {
    if (
      error && typeof error === "object" && "code" in error &&
      error.code === "ordinary_value_unsupported"
    ) {
      fail("preparation_unsupported");
    }
    throw error;
  }
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
  const authorizeReference = options.authorizeReference;
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
  async function loadContent(
    selected: readonly unknown[],
    request: PreparationSourceRequest,
    scope: PreparationSourceScope,
    context: SourceContext,
    beforeBodies?: (
      references: readonly PreparationContentReference[],
    ) => Promise<void>,
  ) {
    if (selected.length > maxReferences) fail("preparation_limit");
    const store = createDatabaseBodyStore({
      session: context.tx,
      schema,
      provisioned: true,
    });
    const content: { ref: OwnerJson; version: OwnerJson; value: OwnerJson }[] =
      [];
    const copies: { reference: PreparationContentReference; bodyId: string }[] =
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
      copies.push({
        bodyId,
        reference: {
          ref: {
            assetId,
            kind: ref.kind,
            role: text(ref.role),
            mediaType: text(ref.mediaType),
          },
          version: { byteLength: byteLength as number, digest: body.digest },
        },
      });
    }
    context.signal.throwIfAborted();
    await beforeBodies?.(
      copies.map(({ reference }) => structuredClone(reference)),
    );
    context.signal.throwIfAborted();
    for (const { bodyId, reference } of copies) {
      context.signal.throwIfAborted();
      const { ref, version } = reference;
      const bytes = await store.readRange({
        bodyId,
        offset: 0,
        end: version.byteLength,
      });
      if (
        bytes.byteLength !== version.byteLength ||
        await digestContent(bytes) !== version.digest
      ) fail("content_corrupted");
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
      content.push({ ref, version, value });
      // Includes escaping/JSON expansion and repeated references, without truncation.
      snapshot(content, maxBytes);
    }
    return content;
  }
  async function currentScope(
    request: PreparationSourceRequest,
    context: SourceContext,
  ): Promise<PreparationSourceScope> {
    context.signal.throwIfAborted();
    const value = object(snapshot(
      await authorize(context.tx, {
        ownerId,
        caller: structuredClone(context.caller),
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
  }
  async function permitOriginal(
    reference: PreparationSourceReference,
    context: SourceContext,
    purpose: "capture" | "duplicate" | "input" | "result",
  ) {
    context.signal.throwIfAborted();
    if (
      !authorizeReference ||
      await authorizeReference(context.tx, {
          ownerId,
          caller: structuredClone(context.caller),
          reference: parsePreparationSourceReference(reference),
          purpose,
          commandTime: context.commandTime,
        }) !== true
    ) fail("preparation_reference_forbidden");
    context.signal.throwIfAborted();
  }
  const readSource = async (
    input: OwnerJson,
    originalContext: SourceContext,
    capture = false,
  ) => {
    const context = {
      ...originalContext,
      caller: structuredClone(originalContext.caller),
    };
    context.signal.throwIfAborted();
    if (capture && !authorizeReference) fail("preparation_reference_forbidden");
    const raw = object(snapshot(input, maxBytes));
    if (
      Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "source") ||
      !Object.hasOwn(raw, "recordId")
    ) fail("preparation_invalid");
    const request = { source: text(raw.source), recordId: text(raw.recordId) };
    const source = sources.get(request.source);
    if (!source) fail("preparation_invalid");
    const scopeNow = () => currentScope(request, context);
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
    // The digest includes only the original authorized record projection and
    // selected immutable content facts, never hidden raw fields or locators.
    const versionFor = (content: readonly PreparationContentReference[]) =>
      digestContent(encoder.encode(canonical({
        source: request.source,
        kind: source.kind,
        recordId: request.recordId,
        namespace: scope.namespace,
        audience: scope.audience,
        record: projected,
        content,
      })));
    let reference: PreparationSourceReference | undefined;
    const content = await loadContent(
      selected,
      request,
      scope,
      context,
      capture
        ? async (content) => {
          reference = parsePreparationSourceReference({
            source: {
              name: request.source,
              kind: source.kind,
              path: source.path,
              recordId: request.recordId,
              namespace: scope.namespace,
              digest: await versionFor(content),
            },
            audience: scope.audience,
            content,
          });
          await permitOriginal(reference, context, "capture");
        }
        : undefined,
    );
    const version = reference?.source.digest ??
      await versionFor(
        content.map(({ ref, version }) => ({
          ref,
          version,
        })) as PreparationContentReference[],
      );
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
    if (reference) await permitOriginal(reference, context, "capture");
    return { projection: output, reference };
  };
  return {
    projections: {
      "preparation.source": async (input, context) =>
        (await readSource(input, context)).projection,
    },
    async capture(input, originalContext) {
      const { projection, reference } = await readSource(
        snapshot(input, maxBytes),
        originalContext,
        true,
      );
      if (!reference) fail("preparation_invalid");
      return snapshot({ projection, reference }, maxBytes) as {
        projection: OwnerJson;
        reference: PreparationSourceReference;
      };
    },
    async authorizeOriginal(input, originalContext, purpose) {
      const context = {
        ...originalContext,
        caller: structuredClone(originalContext.caller),
      };
      const captured = parsePreparationSourceReference(input);
      if ("selection" in captured.source) fail("preparation_forbidden");
      const source = sources.get(captured.source.name);
      if (
        !source || source.kind !== captured.source.kind ||
        source.path !== captured.source.path
      ) fail("preparation_forbidden");
      const request = {
        source: captured.source.name,
        recordId: captured.source.recordId,
      };
      const scope = await currentScope(request, context);
      if (
        scope.namespace !== captured.source.namespace ||
        scope.audience !== captured.audience
      ) fail("preparation_forbidden");
      // Existence/type is checked independently of today's replaceable content
      // field. Policy above must enforce the exact source's current visibility.
      const rows = await context.tx.query<{ id: string }>(
        `SELECT id FROM ${tables.nodes} WHERE id=$1 AND namespace=$2 AND type=$3`,
        [request.recordId, scope.namespace, source.kind],
      );
      if (rows.rows.length !== 1) fail("content_missing");
      await permitOriginal(captured, context, purpose);
      const checked = await loadContent(
        captured.content.map((item) => item.ref),
        request,
        scope,
        context,
        async (references) => {
          if (canonical(references) !== canonical(captured.content)) {
            fail("content_corrupted");
          }
          await permitOriginal(captured, context, purpose);
        },
      );
      if (
        canonical(checked.map(({ ref, version }) => ({ ref, version }))) !==
          canonical(captured.content)
      ) fail("content_corrupted");
      const current = await currentScope(request, context);
      if (
        current.namespace !== scope.namespace ||
        current.audience !== scope.audience
      ) fail("preparation_forbidden");
      await permitOriginal(captured, context, purpose);
      context.signal.throwIfAborted();
    },
  };
}
