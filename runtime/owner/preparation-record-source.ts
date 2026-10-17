/** Private ordinary-Collection source for owner-authorized one-shot preparation.
 * This reader never opens content bodies or writes capture state. The existing
 * child lifecycle owns any later capture. Policy callbacks are trusted reads. */
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";
import { actionSchemaHasSecrets } from "../actions/secret.ts";
import { PROTECTED_VALUE_NODE_TYPE } from "../actions/protected-value.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { digestContent } from "../content/digest.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { assertJsonValue } from "../json.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { OwnerJson, OwnerProjectionHandler } from "./boundary.ts";
import {
  parsePreparationSourceReference,
  type PreparationSourceReference,
} from "./preparation-capture.ts";
import type {
  OwnerPreparationSource,
  OwnerPreparationSourceOptions,
  PreparationSourceRequest,
  PreparationSourceScope,
} from "./preparation-source.ts";

export type OwnerPreparationRecordSourceOptions =
  & Pick<
    OwnerPreparationSourceOptions,
    "ownerId" | "schema" | "authorize" | "projectRecord" | "maxBytes"
  >
  & Readonly<{
    registry: Pick<PluginRegistry, "collections">;
    /** A real registered ordinary Collection, not a caller-authored kind. */
    sources: Readonly<Record<string, Readonly<{ collectionAlias: string }>>>;
    /** Must authorize the whole ORIGINAL projection/version, not merely current
     * row visibility. A digest is provenance and grants no permission itself. */
    authorizeReference: NonNullable<
      OwnerPreparationSourceOptions["authorizeReference"]
    >;
  }>;
export type OwnerPreparationRecordHistorySource = Readonly<{
  name: string;
  kind: string;
  selection: "record";
}>;
export type OwnerPreparationRecordSource =
  & OwnerPreparationSource
  & Readonly<{
    /** Detached validated registration facts, never record values or permission. */
    historySources(): readonly OwnerPreparationRecordHistorySource[];
  }>;
type Context = Parameters<OwnerProjectionHandler>[1];
const encoder = new TextEncoder();
function fail(code = "preparation_invalid"): never {
  throw Object.assign(new Error(code), { code });
}
function text(value: unknown): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 512
  ) fail();
  return value;
}
function snapshot(value: unknown, maxBytes: number): OwnerJson {
  assertJsonValue(value, { maxDepth: 32, maxNodes: 20_000 });
  if (encoder.encode(JSON.stringify(value)).length > maxBytes) {
    fail("preparation_limit");
  }
  return structuredClone(value) as OwnerJson;
}
function object(value: OwnerJson): Record<string, OwnerJson> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, OwnerJson>;
}
function ordinary(value: OwnerJson): void {
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

function canonical(value: OwnerJson): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(object(value)[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
function privateContext(context: Context): Context {
  return {
    tx: context.tx,
    caller: structuredClone(context.caller),
    commandTime: context.commandTime,
    signal: context.signal,
  };
}
export function createOwnerPreparationRecordSource(
  options: OwnerPreparationRecordSourceOptions,
): OwnerPreparationRecordSource {
  const ownerId = text(options.ownerId);
  const tables = createCoreTableNames(options.schema);
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
    fail();
  }
  const { authorize, projectRecord, authorizeReference } = options;
  if (
    ![authorize, projectRecord, authorizeReference].every((value) =>
      typeof value === "function"
    )
  ) fail("preparation_forbidden");
  const sources = new Map(
    Object.entries(object(snapshot(options.sources, maxBytes))).map(
      ([name, value]) => {
        text(name);
        const registration = object(value);
        if (
          Object.keys(registration).length !== 1 ||
          !Object.hasOwn(registration, "collectionAlias")
        ) fail();
        const alias = text(registration.collectionAlias);
        const collection = Object.hasOwn(options.registry.collections, alias)
          ? options.registry.collections[alias]
          : undefined;
        if (
          !collection || collection.content !== undefined ||
          ["asset", PROTECTED_VALUE_NODE_TYPE, "@copilotz/action-content"]
            .includes(
              collection.name,
            )
        ) fail("preparation_unsupported");
        const schema = collection.schema;
        if (
          !schema || typeof schema !== "object" || Array.isArray(schema) ||
          schema.type !== "object" || actionSchemaHasSecrets(schema)
        ) fail("preparation_unsupported");
        snapshot(schema, maxBytes);
        return [name, {
          kind: text(collection.name),
          schema: structuredClone(schema),
        }] as const;
      },
    ),
  );
  async function scope(
    request: PreparationSourceRequest,
    context: Context,
  ): Promise<PreparationSourceScope> {
    context.signal.throwIfAborted();
    const result = object(snapshot(
      await authorize(context.tx, {
        ownerId,
        caller: structuredClone(context.caller),
        request: structuredClone(request),
        commandTime: context.commandTime,
      }),
      maxBytes,
    ));
    context.signal.throwIfAborted();
    if (
      Object.keys(result).length !== 2 || !Object.hasOwn(result, "namespace") ||
      !Object.hasOwn(result, "audience")
    ) fail();
    return {
      namespace: text(result.namespace),
      audience: text(result.audience),
    };
  }
  async function permit(
    reference: PreparationSourceReference,
    context: Context,
    purpose: "capture" | "duplicate" | "input" | "result",
  ) {
    context.signal.throwIfAborted();
    if (
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
  async function finalScope(
    request: PreparationSourceRequest,
    original: PreparationSourceScope,
    context: Context,
  ) {
    const current = await scope(request, context);
    if (
      current.namespace !== original.namespace ||
      current.audience !== original.audience
    ) fail("preparation_forbidden");
  }
  async function read(
    input: PreparationSourceRequest,
    originalContext: Context,
  ) {
    const context = privateContext(originalContext);
    const raw = object(snapshot(input, maxBytes));
    if (
      Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "source") ||
      !Object.hasOwn(raw, "recordId")
    ) fail();
    const request = { source: text(raw.source), recordId: text(raw.recordId) };
    const source = sources.get(request.source);
    if (!source) fail();
    const current = await scope(request, context);
    const rows = await context.tx.query<{ data: unknown; bytes: number }>(
      `SELECT CASE WHEN octet_length(data::text)<=$4 THEN data END AS data, octet_length(data::text) AS bytes FROM ${tables.nodes} WHERE id=$1 AND namespace=$2 AND type=$3`,
      [request.recordId, current.namespace, source.kind, maxBytes],
    );
    context.signal.throwIfAborted();
    if (rows.rows.length !== 1) fail("preparation_source_missing");
    if (Number(rows.rows[0].bytes) > maxBytes) fail("preparation_limit");
    const record = object(
      snapshot({
        ...object(snapshot(rows.rows[0].data, maxBytes)),
        id: request.recordId,
        namespace: current.namespace,
      }, maxBytes),
    );
    ordinary(record);
    validateAgainstJsonSchema(
      source.schema,
      record,
      "Preparation ordinary record",
    );
    const projected = snapshot(
      await projectRecord(structuredClone(record), {
        request: structuredClone(request),
        scope: structuredClone(current),
      }),
      maxBytes,
    );
    ordinary(projected);
    context.signal.throwIfAborted();
    const digest = await digestContent(encoder.encode(canonical({
      source: request.source,
      kind: source.kind,
      recordId: request.recordId,
      namespace: current.namespace,
      audience: current.audience,
      record: projected,
    })));
    const reference = parsePreparationSourceReference({
      source: {
        selection: "record",
        name: request.source,
        kind: source.kind,
        recordId: request.recordId,
        namespace: current.namespace,
        digest,
      },
      audience: current.audience,
      content: [],
    });
    await permit(reference, context, "capture");
    const projection = snapshot({
      source: reference.source,
      audience: current.audience,
      record: projected,
      content: [],
    }, maxBytes);
    const result = snapshot({ projection, reference }, maxBytes) as {
      projection: OwnerJson;
      reference: PreparationSourceReference;
    };
    await finalScope(request, current, context);
    await permit(reference, context, "capture");
    return result;
  }
  return {
    historySources() {
      return [...sources].map(([name, source]) => ({
        name,
        kind: source.kind,
        selection: "record" as const,
      }));
    },
    capture: read,
    projections: {
      "preparation.source": async (input, context) =>
        (await read(input as PreparationSourceRequest, context)).projection,
    },
    async authorizeOriginal(input, originalContext, purpose) {
      const context = privateContext(originalContext);
      const reference = parsePreparationSourceReference(
        snapshot(input, maxBytes),
      );
      if (
        !("selection" in reference.source) ||
        reference.source.selection !== "record"
      ) {
        fail("preparation_forbidden");
      }
      const source = sources.get(reference.source.name);
      if (!source || source.kind !== reference.source.kind) {
        fail("preparation_forbidden");
      }
      const request = {
        source: reference.source.name,
        recordId: reference.source.recordId,
      };
      const current = await scope(request, context);
      if (
        current.namespace !== reference.source.namespace ||
        current.audience !== reference.audience
      ) fail("preparation_forbidden");
      await permit(reference, context, purpose);
      const rows = await context.tx.query<{ id: string }>(
        `SELECT id FROM ${tables.nodes} WHERE id=$1 AND namespace=$2 AND type=$3`,
        [request.recordId, current.namespace, source.kind],
      );
      if (rows.rows.length !== 1) fail("preparation_source_missing");
      context.signal.throwIfAborted();
      await finalScope(request, current, context);
      await permit(reference, context, purpose);
    },
  };
}
