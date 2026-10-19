import { captureCollectionPolicy } from "../collections/policy-authorization.ts";
import type { CollectionPolicyRegistrations } from "../collections/policy-registration.ts";
import { loadCollectionRecord } from "../collections/reducer.ts";
import type { ProtectedActionSource } from "./protected-action-types.ts";
/** Registered record/content selection. Replay checks the original coordinates;
 * today's visible fields are never substituted for the captured projection. */
import type { SqlExecutor } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type { ContentResolver } from "../content/resolver.ts";
import type { ContentRef } from "../content/types.ts";
import { contentRefSchema } from "../content/schema.ts";
import { digestContent } from "../content/digest.ts";
import { getPath } from "../collections/content-path.ts";
import { declaredCollectionJsonField } from "../collections/field.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { splitSecretActionValue } from "./secret.ts";
import {
  parsePreparationSourceReference,
  type PreparationContentReference,
  type PreparationSourceReference,
} from "./preparation-capture.ts";
import {
  assertPreparationProjection,
  preparationCanonical as canonical,
  preparationData as snapshot,
  preparationError as fail,
  preparationRefusal as refuse,
  preparationText as text,
} from "./preparation-data.ts";

export type PreparationPurpose =
  | "capture"
  | "duplicate"
  | "claim"
  | "input"
  | "mutation"
  | "result";
export type PreparationSourceRequest = Readonly<
  { source: string; recordId: string }
>;
export type PreparationSourceScope = Readonly<
  { namespace: string; audience: string }
>;
/** Established only from the actual owner invocation, never request metadata. */
export type PreparationActionBinding = Readonly<{
  namespace: string;
  actionId: string;
  actionRunId: string;
  parentActionRunId?: string;
  sourceEventId: string;
  operationId?: string;
}>;
export type PreparationPolicyAuthority = Readonly<{
  /** Owner-bound retained ingress/operation chain; caller metadata grants nothing. */
  resolveSource(): Promise<ProtectedActionSource>;
}>;
export type PreparationContext =
  & Readonly<{
    tx: SqlExecutor;
    binding: PreparationActionBinding;
    commandTime: string;
    signal: AbortSignal;
  }>
  & PreparationPolicyAuthority;
export type PreparationRecordRegistration = Readonly<{
  collectionAlias: string;
  /** Exact original JSON Pointer fields made available to the projector. */
  fields: readonly string[];
  /** A registered content field; omission selects the authorized record. */
  contentPath?: string;
}>;
export type PreparationSourcePolicy = Readonly<{
  sources: Readonly<Record<string, PreparationRecordRegistration>>;
  authorize(
    tx: SqlExecutor,
    input: Readonly<
      {
        binding: PreparationActionBinding;
        request: PreparationSourceRequest;
        commandTime: string;
        signal: AbortSignal;
      } & PreparationPolicyAuthority
    >,
  ): PreparationSourceScope | Promise<PreparationSourceScope>;
  /** Receives the public schema projection. Protected collections are supported,
   * but their encrypted envelopes and secret slots never enter a View. */
  projectRecord(
    record: Readonly<Record<string, unknown>>,
    input: Readonly<
      {
        request: PreparationSourceRequest;
        scope: PreparationSourceScope;
        signal: AbortSignal;
      }
    >,
  ): unknown | Promise<unknown>;
  /** Mandatory current policy over ORIGINAL fields/content versions. A digest
   * alone never grants authority and must not be compared to today's value. */
  authorizeOriginal(
    tx: SqlExecutor,
    input: Readonly<
      {
        binding: PreparationActionBinding;
        reference: PreparationSourceReference;
        purpose: PreparationPurpose;
        commandTime: string;
        signal: AbortSignal;
      } & PreparationPolicyAuthority
    >,
  ): boolean | Promise<boolean>;
}>;

export function createPreparationSource(
  options: Readonly<{
    schema: string;
    registry: Pick<PluginRegistry, "collections">;
    policy: PreparationSourcePolicy;
    content: ContentResolver;
    maxBytes?: number;
    collectionPolicies?: CollectionPolicyRegistrations;
  }>,
) {
  const tables = createCoreTableNames(options.schema);
  const maxBytes = options.maxBytes ?? 65_536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
    fail();
  }
  const { authorize, projectRecord, authorizeOriginal } = options.policy;
  if (
    ![authorize, projectRecord, authorizeOriginal].every((fn) =>
      typeof fn === "function"
    )
  ) fail("preparation_forbidden");
  const registrations = snapshot(options.policy.sources) as Record<
    string,
    PreparationRecordRegistration
  >;
  const sources = new Map(
    Object.entries(registrations).map(([name, registration]) => {
      text(name);
      if (
        Object.keys(registration).some((key) =>
          !["collectionAlias", "contentPath", "fields"].includes(key)
        )
      ) fail();
      const alias = text(registration.collectionAlias);
      const definition = Object.hasOwn(options.registry.collections, alias)
        ? options.registry.collections[alias]
        : undefined;
      if (
        !definition || typeof definition.schema !== "object" ||
        ["asset", "protected_value", "@copilotz/action-content"].includes(
          definition.name,
        )
      ) fail();
      const fields = registration.fields;
      if (
        !Array.isArray(fields) || fields.length > 128 ||
        new Set(fields).size !== fields.length
      ) fail();
      for (const field of fields) {
        text(field);
        if (
          !field.startsWith("/") || /~(?:[^01]|$)/.test(field) ||
          field.slice(1).split("/").some((part: string) =>
            !part ||
            ["__proto__", "prototype", "constructor"].includes(
              part.replaceAll("~1", "/").replaceAll("~0", "~"),
            )
          )
        ) fail();
      }
      if (
        fields.some((a) => fields.some((b) => a !== b && b.startsWith(`${a}/`)))
      ) fail();
      const path = registration.contentPath;
      if (path !== undefined) {
        text(path);
        declaredCollectionJsonField(definition, path);
        if (!definition.content?.fields.includes(path)) fail();
      }
      return [name, {
        kind: text(definition.name),
        schema: structuredClone(definition.schema),
        path,
        fields: [...fields],
      }] as const;
    }),
  );
  async function collectionPolicy(
    kind: string,
    id: string,
    context: PreparationContext,
  ) {
    const registration = options.collectionPolicies?.get(kind);
    if (!registration) return;
    const policy = captureCollectionPolicy({
      registration,
      namespace: context.binding.namespace,
      databaseSchema: options.schema,
      method: "get",
      args: { id },
      current: (tx) =>
        loadCollectionRecord(tx, tables, context.binding.namespace, kind, id),
    }, {
      scope: {
        namespace: context.binding.namespace,
        databaseSchema: options.schema,
      },
      invocation: {
        kind: "action",
        id: context.binding.actionId,
        runId: context.binding.actionRunId,
        ...(context.binding.parentActionRunId
          ? { parentRunId: context.binding.parentActionRunId }
          : {}),
      },
      signal: context.signal,
      check: () => context.signal.throwIfAborted(),
      resolveSource: () => context.resolveSource(),
    });
    const command = {
      transaction: context.tx,
      commandTime: context.commandTime,
    };
    await policy.authorize(command, "read");
    await policy.authorize(command, "result");
  }
  const requestFor = (
    reference: PreparationSourceReference,
  ): PreparationSourceRequest => ({
    source: reference.source.name,
    recordId: reference.source.recordId,
  });
  async function scope(
    request: PreparationSourceRequest,
    context: PreparationContext,
  ): Promise<PreparationSourceScope> {
    context.signal.throwIfAborted();
    const value = snapshot(
      await authorize(context.tx, {
        binding: structuredClone(context.binding),
        request: structuredClone(request),
        commandTime: context.commandTime,
        resolveSource: context.resolveSource,
        signal: AbortSignal.any([context.signal]),
      }),
    ) as PreparationSourceScope;
    if (
      !value || typeof value !== "object" ||
      Object.keys(value).sort().join(",") !== "audience,namespace" ||
      text(value.namespace) !== context.binding.namespace
    ) refuse("preparation_forbidden");
    text(value.audience);
    context.signal.throwIfAborted();
    return value;
  }
  async function permit(
    reference: PreparationSourceReference,
    purpose: PreparationPurpose,
    context: PreparationContext,
  ) {
    context.signal.throwIfAborted();
    if (
      await authorizeOriginal(context.tx, {
        binding: structuredClone(context.binding),
        reference: parsePreparationSourceReference(reference),
        purpose,
        commandTime: context.commandTime,
        resolveSource: context.resolveSource,
        signal: AbortSignal.any([context.signal]),
      }) !== true
    ) refuse("preparation_reference_forbidden");
    context.signal.throwIfAborted();
  }
  async function contentFacts(
    refs: readonly ContentRef[],
    context: PreparationContext,
  ): Promise<PreparationContentReference[]> {
    if (refs.length > 100) fail("preparation_limit");
    let bytes = 0;
    const facts: PreparationContentReference[] = [];
    for (const ref of refs) {
      validateAgainstJsonSchema(
        contentRefSchema,
        ref,
        "Preparation ContentRef",
      );
      if (ref.kind !== "text" && ref.kind !== "json") {
        fail("preparation_content_unsupported");
      }
      await options.content.authorize(ref, {
        namespace: context.binding.namespace,
        signal: context.signal,
      });
      const rows = await context.tx.query<
        {
          data: {
            state: string;
            digest: string;
            byteLength: number;
            mediaType: string;
          };
        }
      >(
        `SELECT data FROM ${tables.nodes} WHERE namespace=$1 AND type='asset' AND id=$2`,
        [context.binding.namespace, ref.assetId],
      );
      const asset = rows.rows[0]?.data;
      if (!asset || asset.state !== "ready") {
        refuse("preparation_content_missing");
      }
      if (
        !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
        asset.mediaType !== ref.mediaType
      ) refuse("preparation_content_corrupted");
      bytes += asset.byteLength;
      if (bytes > maxBytes) fail("preparation_limit");
      facts.push({
        ref: {
          assetId: text(ref.assetId),
          kind: ref.kind,
          role: text(ref.role),
          mediaType: text(ref.mediaType),
        },
        version: { digest: asset.digest, byteLength: asset.byteLength },
      });
    }
    return facts;
  }
  async function contentValues(
    facts: readonly PreparationContentReference[],
    context: PreparationContext,
  ) {
    const values = await options.content.getMany(
      facts.map((item) => item.ref),
      {
        namespace: context.binding.namespace,
        signal: context.signal,
        maxBytes,
      },
    );
    if (values.length !== facts.length) refuse("preparation_content_missing");
    return values.map((value, index) => {
      const fact = facts[index];
      if (
        value.asset.digest !== fact.version.digest ||
        value.asset.byteLength !== fact.version.byteLength ||
        value.bytes.byteLength !== fact.version.byteLength
      ) refuse("preparation_content_corrupted");
      const projected = value.ref.kind === "json" ? value.value : value.text;
      assertPreparationProjection(projected);
      return { ref: fact.ref, version: fact.version, value: projected };
    });
  }
  async function authorizeCaptured(
    raw: PreparationSourceReference,
    context: PreparationContext,
    purpose: PreparationPurpose,
  ) {
    const reference = parsePreparationSourceReference(raw);
    const source = sources.get(reference.source.name);
    if (
      !source ||
      canonical(source.fields) !== canonical(reference.source.fields) ||
      source.kind !== reference.source.kind ||
      (source.path === undefined
        ? !("selection" in reference.source)
        : !("path" in reference.source) ||
          source.path !== reference.source.path)
    ) refuse("preparation_forbidden");
    const current = await scope(requestFor(reference), context);
    if (
      current.namespace !== reference.source.namespace ||
      current.audience !== reference.audience
    ) refuse("preparation_forbidden");
    await permit(reference, purpose, context);
    await collectionPolicy(
      reference.source.kind,
      reference.source.recordId,
      context,
    );
    const exists = await context.tx.query(
      `SELECT id FROM ${tables.nodes} WHERE namespace=$1 AND type=$2 AND id=$3`,
      [
        reference.source.namespace,
        reference.source.kind,
        reference.source.recordId,
      ],
    );
    if (exists.rows.length !== 1) refuse("preparation_source_missing");
    const facts = await contentFacts(
      reference.content.map((item) => item.ref),
      context,
    );
    if (canonical(facts) !== canonical(reference.content)) {
      refuse("preparation_content_corrupted");
    }
    // Reading original bodies establishes availability and verifies integrity;
    // these bytes are discarded and never replace captured child input.
    await contentValues(facts, context);
    const final = await scope(requestFor(reference), context);
    if (canonical(final) !== canonical(current)) {
      refuse("preparation_forbidden");
    }
    await permit(reference, purpose, context);
  }
  return {
    authorizeOriginal: authorizeCaptured,
    async capture(
      input: PreparationSourceRequest,
      context: PreparationContext,
    ) {
      const request = snapshot(input) as PreparationSourceRequest;
      if (Object.keys(request).sort().join(",") !== "recordId,source") fail();
      text(request.source);
      text(request.recordId);
      const source = sources.get(request.source);
      if (!source) fail("preparation_source_unknown");
      const current = await scope(request, context);
      await collectionPolicy(source.kind, request.recordId, context);
      const rows = await context.tx.query<{ data: unknown; bytes: number }>(
        `SELECT CASE WHEN octet_length(data::text)<=$4 THEN data END AS data, octet_length(data::text) AS bytes FROM ${tables.nodes} WHERE namespace=$1 AND type=$2 AND id=$3`,
        [current.namespace, source.kind, request.recordId, maxBytes],
      );
      if (rows.rows.length !== 1) refuse("preparation_source_missing");
      if (Number(rows.rows[0].bytes) > maxBytes) fail("preparation_limit");
      const raw = snapshot(rows.rows[0].data, maxBytes) as Record<
        string,
        unknown
      >;
      const record = {
        ...raw,
        id: request.recordId,
        namespace: current.namespace,
      };
      // Domain-protected values are never opened here. Projection sees only the
      // registered schema's public slots, preserving supported safe Views.
      const safe = splitSecretActionValue(source.schema, record)
        .publicValue as Record<string, unknown>;
      const selectedRecord: Record<string, unknown> = {};
      for (const field of source.fields) {
        const parts = field.slice(1).split("/").map((part: string) =>
          part.replaceAll("~1", "/").replaceAll("~0", "~")
        );
        let value: unknown = safe;
        for (const part of parts) {
          value =
            value && typeof value === "object" && Object.hasOwn(value, part)
              ? (value as Record<string, unknown>)[part]
              : undefined;
        }
        if (value === undefined) refuse("preparation_source_missing");
        let target = selectedRecord;
        for (const part of parts.slice(0, -1)) {
          target = (target[part] ??= {}) as Record<string, unknown>;
        }
        target[parts.at(-1)!] = value;
      }
      const projected = snapshot(
        await projectRecord(selectedRecord, {
          request: structuredClone(request),
          scope: structuredClone(current),
          signal: AbortSignal.any([context.signal]),
        }),
        maxBytes,
      );
      assertPreparationProjection(projected);
      const selected = source.path === undefined
        ? []
        : getPath(record, source.path);
      if (!Array.isArray(selected)) fail();
      const facts = await contentFacts(selected, context);
      const fields = source.fields;
      const reference = parsePreparationSourceReference({
        source: {
          name: request.source,
          kind: source.kind,
          recordId: request.recordId,
          namespace: current.namespace,
          ...(source.path === undefined
            ? { selection: "record" }
            : { path: source.path }),
          fields,
          digest: await digestContent(
            new TextEncoder().encode(
              canonical({ record: projected, content: facts }),
            ),
          ),
        },
        audience: current.audience,
        content: facts,
      });
      await permit(reference, "capture", context);
      const values = await contentValues(facts, context);
      await authorizeCaptured(reference, context, "capture");
      return {
        reference,
        projection: snapshot({
          record: projected,
          content: values,
          source: reference.source,
          audience: current.audience,
        }, maxBytes),
      } as const;
    },
  };
}
