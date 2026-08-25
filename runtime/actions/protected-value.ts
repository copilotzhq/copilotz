/** BodyStore-backed encrypted values owned by Action lifecycle records. @module */

import {
  assetBodySchemaPrefix,
  type BodyStorageRuntime,
  type BodyStore,
  type BodyStoreDeployment,
  type BodyStoreKind,
  createDatabaseBodyStore,
  digestContent,
  readBodyBytes,
} from "../content/index.ts";
import {
  bodyProtectionUntil,
  DEFAULT_BODY_PROTECTION_MS,
} from "../content/body-store.ts";
import type { EventMutationContext, SqlSession } from "../events/index.ts";
import { snapshotEventData } from "../events/types.ts";
import {
  createSecretAdapter,
  type SecretAdapter,
  secretEnvelope,
} from "./secret-adapter.ts";
import { durableActionValue, sameActionValue } from "./value.ts";

export const PROTECTED_VALUE_REF_SCHEMA =
  "copilotz.action.protected-value.v1" as const;
export const PROTECTED_VALUE_NODE_TYPE = "protected_value" as const;
const PROTECTED_VALUE_MEDIA_TYPE =
  "application/vnd.copilotz.action-protected-value+json";

export type ProtectedValueCoordinates = Readonly<{
  namespace: string;
  ownerId: string;
  slot: string;
}>;

export type ProtectedValueRef = Readonly<{
  schema: typeof PROTECTED_VALUE_REF_SCHEMA;
  ownerNodeId: string;
  bodyId: string;
  storeKind: BodyStoreKind;
  backendId: string;
  byteLength: number;
  digest: `sha256:${string}`;
  mediaType: typeof PROTECTED_VALUE_MEDIA_TYPE;
  commitment: string;
  envelope: Readonly<Record<string, unknown>>;
  protectedUntil: string;
}>;

export type PreparedProtectedValue = Readonly<{
  ref: ProtectedValueRef;
  /** Default database storage is adopted atomically with the owning Event. */
  databaseBytes?: Uint8Array;
}>;

export type ProtectedValueRuntime = Readonly<{
  prepare(
    coordinates: ProtectedValueCoordinates,
    value: unknown,
  ): Promise<PreparedProtectedValue>;
  open(
    coordinates: ProtectedValueCoordinates,
    ref: ProtectedValueRef,
  ): Promise<unknown>;
  adopt(
    context: EventMutationContext,
    namespace: string,
    prepared: PreparedProtectedValue,
  ): Promise<void>;
  project(
    context: EventMutationContext,
    namespace: string,
    ref: ProtectedValueRef,
  ): Promise<void>;
}>;

type CreateProtectedValueRuntimeOptions = Readonly<{
  databaseSchema: string;
  session: SqlSession;
  storage: BodyStorageRuntime;
  adapter: SecretAdapter;
  createId?: () => string;
}>;

const DATABASE_DEPLOYMENT: BodyStoreDeployment = Object.freeze({
  durability: "durable",
  reach: "cluster",
  minimumProtectionMs: DEFAULT_BODY_PROTECTION_MS,
  readyGarbageCollection: true,
});

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function cleanSegment(value: string): string {
  return encodeURIComponent(value.trim()).replaceAll("%2F", "%252F");
}

function bodyKey(
  prefix: string,
  databaseSchema: string,
  namespace: string,
  id: string,
): string {
  const root = assetBodySchemaPrefix({ prefix, databaseSchema });
  return [
    root,
    "namespaces",
    cleanSegment(namespace),
    "protected-values",
    cleanSegment(id),
  ].filter(Boolean).join("/");
}

function additionalAuthenticatedData(
  databaseSchema: string,
  coordinates: ProtectedValueCoordinates,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schema: "copilotz.action.protected-value-aad.v1",
    databaseSchema,
    namespace: requiredText(coordinates.namespace, "Protected namespace"),
    ownerId: requiredText(coordinates.ownerId, "Protected owner id"),
    slot: requiredText(coordinates.slot, "Protected slot"),
  }));
}

function reference(value: unknown): ProtectedValueRef {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const exact = new Set([
    "schema",
    "ownerNodeId",
    "bodyId",
    "storeKind",
    "backendId",
    "byteLength",
    "digest",
    "mediaType",
    "commitment",
    "envelope",
    "protectedUntil",
  ]);
  if (
    Reflect.ownKeys(input).some((key) =>
      typeof key !== "string" || !exact.has(key)
    ) || input.schema !== PROTECTED_VALUE_REF_SCHEMA ||
    (input.storeKind !== "memory" && input.storeKind !== "filesystem" &&
      input.storeKind !== "object" && input.storeKind !== "database") ||
    input.mediaType !== PROTECTED_VALUE_MEDIA_TYPE ||
    !Number.isSafeInteger(input.byteLength) || Number(input.byteLength) < 0 ||
    typeof input.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(input.digest) ||
    typeof input.protectedUntil !== "string" ||
    !Number.isFinite(Date.parse(input.protectedUntil))
  ) {
    throw new TypeError("Protected value reference is invalid.");
  }
  const commitment = requiredText(input.commitment, "Protected commitment");
  if (commitment.length > 1_024) {
    throw new TypeError("Protected commitment is too long.");
  }
  return Object.freeze({
    schema: PROTECTED_VALUE_REF_SCHEMA,
    ownerNodeId: requiredText(input.ownerNodeId, "Protected owner node id"),
    bodyId: requiredText(input.bodyId, "Protected body id"),
    storeKind: input.storeKind,
    backendId: requiredText(input.backendId, "Protected backend id"),
    byteLength: Number(input.byteLength),
    digest: input.digest as `sha256:${string}`,
    mediaType: PROTECTED_VALUE_MEDIA_TYPE,
    commitment,
    envelope: secretEnvelope(input.envelope),
    protectedUntil: new Date(input.protectedUntil).toISOString(),
  });
}

export function protectedValueRef(value: unknown): ProtectedValueRef {
  return reference(snapshotEventData(value, "Protected value reference"));
}

function nodeData(ref: ProtectedValueRef): Readonly<Record<string, unknown>> {
  return Object.freeze({
    state: "ready",
    bodyId: ref.bodyId,
    byteLength: ref.byteLength,
    digest: ref.digest,
    mediaType: ref.mediaType,
    location: Object.freeze({
      kind: ref.storeKind,
      backendId: ref.backendId,
    }),
  });
}

async function insertOwner(
  context: EventMutationContext,
  databaseSchema: string,
  namespace: string,
  ref: ProtectedValueRef,
  databaseBytes?: Uint8Array,
): Promise<void> {
  await context.transaction.query(
    "SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))",
    [databaseSchema, "body-ownership"],
  );
  if (databaseBytes) {
    const store = createDatabaseBodyStore({
      session: context.transaction,
      schema: databaseSchema,
      backendId: ref.backendId,
    });
    await store.put({
      bodyId: ref.bodyId,
      bytes: databaseBytes,
      mediaType: ref.mediaType,
      digest: ref.digest,
      ifAbsent: true,
      protectedUntil: ref.protectedUntil,
    });
  }
  const expected = nodeData(ref);
  await context.transaction.query(
    `INSERT INTO ${context.tables.nodes} (
       id, namespace, type, name, data, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      ref.ownerNodeId,
      namespace,
      PROTECTED_VALUE_NODE_TYPE,
      "protected-value",
      JSON.stringify(expected),
    ],
  );
  const existing = await context.transaction.query<{
    namespace: string;
    type: string;
    data: unknown;
  }>(
    `SELECT namespace, type, data FROM ${context.tables.nodes}
      WHERE id = $1 LIMIT 1`,
    [ref.ownerNodeId],
  );
  const row = existing.rows[0];
  if (
    !row || row.namespace !== namespace ||
    row.type !== PROTECTED_VALUE_NODE_TYPE ||
    !sameActionValue(row.data, expected)
  ) {
    throw new Error("Protected value owner conflicts with persisted state.");
  }
}

/** Creates the encrypted storage authority for one physical database scope. */
export function createProtectedValueRuntime(
  options: CreateProtectedValueRuntimeOptions,
): ProtectedValueRuntime {
  const databaseSchema = requiredText(
    options.databaseSchema,
    "Protected database schema",
  );
  const adapter = createSecretAdapter(options.adapter);
  const createId = options.createId ?? (() => crypto.randomUUID());
  const storeFor = (namespace: string): BodyStore =>
    options.storage.adapter?.forScope({ namespace, databaseSchema }) ??
      options.storage.writer ?? createDatabaseBodyStore({
        session: options.session,
        schema: databaseSchema,
      });
  const deployment = options.storage.adapter?.deployment ??
    DATABASE_DEPLOYMENT;
  const readerFor = (namespace: string, backendId: string): BodyStore => {
    const current = storeFor(namespace);
    if (current.backendId === backendId) return current;
    const reader = options.storage.readers.get(backendId);
    if (!reader) {
      throw new Error("Protected value body backend is unavailable.");
    }
    return reader;
  };

  return Object.freeze({
    async prepare(coordinates, value) {
      const namespace = requiredText(
        coordinates.namespace,
        "Protected namespace",
      );
      const canonical = durableActionValue(value);
      const plaintext = new TextEncoder().encode(JSON.stringify(canonical));
      const aad = additionalAuthenticatedData(databaseSchema, coordinates);
      let sealed;
      try {
        sealed = await adapter.seal({
          plaintext: plaintext.slice(),
          additionalAuthenticatedData: aad.slice(),
        });
      } catch {
        throw new Error("Secret protection failed.");
      }
      if (
        !sealed || typeof sealed !== "object" ||
        !(sealed.ciphertext instanceof Uint8Array)
      ) {
        throw new Error("Secret protection failed.");
      }
      const commitment = requiredText(
        sealed.commitment,
        "Secret Adapter commitment",
      );
      if (commitment.length > 1_024) {
        throw new TypeError("Secret Adapter commitment is too long.");
      }
      const envelope = secretEnvelope(sealed.envelope);
      const ciphertext = sealed.ciphertext.slice();
      const digest = await digestContent(ciphertext);
      const ownerNodeId = `protected-value:${createId()}`;
      const bodyId = bodyKey(
        options.storage.prefix,
        databaseSchema,
        namespace,
        createId(),
      );
      const store = storeFor(namespace);
      const protectedUntil = bodyProtectionUntil(Math.max(
        DEFAULT_BODY_PROTECTION_MS,
        deployment.minimumProtectionMs,
      ));
      const databaseBytes = !options.storage.adapter &&
          !options.storage.writer && store.kind === "database"
        ? ciphertext
        : undefined;
      const head = databaseBytes
        ? Object.freeze({
          bodyId,
          state: "ready" as const,
          byteLength: ciphertext.byteLength,
          mediaType: PROTECTED_VALUE_MEDIA_TYPE,
          digest,
          maintenanceVersion: 1,
          protectedUntil,
        })
        : await store.put({
          bodyId,
          bytes: ciphertext,
          mediaType: PROTECTED_VALUE_MEDIA_TYPE,
          digest,
          ifAbsent: true,
          protectedUntil,
        });
      const ref = reference({
        schema: PROTECTED_VALUE_REF_SCHEMA,
        ownerNodeId,
        bodyId,
        storeKind: store.kind,
        backendId: store.backendId,
        byteLength: head.byteLength,
        digest: head.digest,
        mediaType: PROTECTED_VALUE_MEDIA_TYPE,
        commitment,
        envelope,
        protectedUntil: head.protectedUntil ?? protectedUntil,
      });
      return Object.freeze({
        ref,
        ...(databaseBytes ? { databaseBytes: databaseBytes.slice() } : {}),
      });
    },
    async open(coordinates, rawRef) {
      const ref = reference(rawRef);
      const namespace = requiredText(
        coordinates.namespace,
        "Protected namespace",
      );
      const store = readerFor(namespace, ref.backendId);
      const head = await store.head({ bodyId: ref.bodyId });
      if (
        !head || head.state !== "ready" || head.byteLength !== ref.byteLength ||
        head.digest !== ref.digest || head.mediaType !== ref.mediaType ||
        store.kind !== ref.storeKind
      ) throw new Error("Protected value body is inconsistent.");
      const ciphertext = await readBodyBytes(store, { bodyId: ref.bodyId });
      if (await digestContent(ciphertext) !== ref.digest) {
        throw new Error("Protected value body integrity check failed.");
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await adapter.open({
          ciphertext: ciphertext.slice(),
          additionalAuthenticatedData: additionalAuthenticatedData(
            databaseSchema,
            coordinates,
          ),
          envelope: ref.envelope,
        });
      } catch {
        throw new Error("Secret recovery failed.");
      }
      if (!(plaintext instanceof Uint8Array)) {
        throw new Error("Secret recovery failed.");
      }
      try {
        return durableActionValue(
          JSON.parse(new TextDecoder().decode(plaintext)),
        );
      } catch {
        throw new Error("Secret recovery failed.");
      }
    },
    adopt(context, namespace, prepared) {
      const ref = reference(prepared.ref);
      const deadline = Date.parse(ref.protectedUntil);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) {
        throw new Error(
          "Protected value body protection expired before adoption.",
        );
      }
      return insertOwner(
        context,
        databaseSchema,
        namespace,
        ref,
        prepared.databaseBytes?.slice(),
      );
    },
    project(context, namespace, rawRef) {
      return insertOwner(
        context,
        databaseSchema,
        namespace,
        reference(rawRef),
        undefined,
      );
    },
  });
}
