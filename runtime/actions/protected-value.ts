import {
  ensureOwnerDataKey,
  ownerDataCipher,
  readOwnerDataKey,
} from "./owner-data-key.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import {
  createPromotedBodyStore,
  promoteConfiguredLogicalBody,
  promotedReadyStore,
} from "../content/promoted-body-store.ts";
import {
  assertSchemaCommandTransaction,
  schemaCommandContext,
} from "../engine/commands.ts";
/** BodyStore-backed encrypted values owned by Action lifecycle records. @module */

import {
  assetBodySchemaPrefix,
  type BodyStorageRuntime,
  type BodyStore,
  createDatabaseBodyStore,
  digestContent,
} from "../content/index.ts";
import { createContentCatalog, openLogicalBody } from "../content/catalog.ts";
import {
  databaseBodyStoreReader,
  databaseBodyStoreWriter,
  provisionDatabaseBodyStore,
} from "../content/database-body-store.ts";
import type {
  EventMutationContext,
  SqlExecutor,
  SqlSession,
} from "../events/index.ts";
import { snapshotEventData } from "../events/types.ts";
import {
  createSecretAdapter,
  type SecretAdapter,
  secretEnvelope,
} from "./secret-adapter.ts";
import { durableActionValue, sameActionValue } from "./value.ts";
import { protectedValueReadCheck } from "./protected-value-read.ts";

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
  byteLength: number;
  digest: `sha256:${string}`;
  mediaType: typeof PROTECTED_VALUE_MEDIA_TYPE;
  commitment: string;
  envelope: Readonly<Record<string, unknown>>;
}>;

export type PreparedProtectedValue = Readonly<{
  ref: ProtectedValueRef;
}>;

export type ProtectedValueRuntime = Readonly<{
  prepare(
    coordinates: ProtectedValueCoordinates,
    value: unknown,
    transaction?: SqlExecutor,
  ): Promise<PreparedProtectedValue>;
  open(
    coordinates: ProtectedValueCoordinates,
    ref: ProtectedValueRef,
    transaction?: SqlExecutor,
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

export function additionalAuthenticatedData(
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
    "byteLength",
    "digest",
    "mediaType",
    "commitment",
    "envelope",
  ]);
  if (
    Reflect.ownKeys(input).some((key) =>
      typeof key !== "string" || !exact.has(key)
    ) || input.schema !== PROTECTED_VALUE_REF_SCHEMA ||
    input.mediaType !== PROTECTED_VALUE_MEDIA_TYPE ||
    !Number.isSafeInteger(input.byteLength) || Number(input.byteLength) < 0 ||
    typeof input.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(input.digest)
  ) {
    throw new TypeError("Protected value reference is invalid.");
  }
  const commitment = requiredText(input.commitment, "Protected commitment");
  if (commitment.length > 1_024) {
    throw new TypeError("Protected commitment is too long.");
  }
  return ({
    schema: PROTECTED_VALUE_REF_SCHEMA,
    ownerNodeId: requiredText(input.ownerNodeId, "Protected owner node id"),
    bodyId: requiredText(input.bodyId, "Protected body id"),
    byteLength: Number(input.byteLength),
    digest: input.digest as `sha256:${string}`,
    mediaType: PROTECTED_VALUE_MEDIA_TYPE,
    commitment,
    envelope: secretEnvelope(input.envelope),
  } as const);
}

export function protectedValueRef(value: unknown): ProtectedValueRef {
  return reference(snapshotEventData(value, "Protected value reference"));
}

function nodeData(ref: ProtectedValueRef): Readonly<Record<string, unknown>> {
  return ({
    state: "ready",
    bodyId: ref.bodyId,
    byteLength: ref.byteLength,
    digest: ref.digest,
    mediaType: ref.mediaType,
  } as const);
}

async function insertOwner(
  context: EventMutationContext,
  databaseSchema: string,
  namespace: string,
  ref: ProtectedValueRef,
): Promise<void> {
  assertSchemaCommandTransaction(context.transaction, databaseSchema);
  const catalog = createContentCatalog(context.transaction, databaseSchema);
  const body = await catalog.read(ref.bodyId);
  if (
    !body || body.namespace !== namespace ||
    body.terminal?.outcome !== "completed" ||
    body.terminal.length !== ref.byteLength ||
    body.terminal.digest !== ref.digest
  ) throw new Error("Protected body catalog is inconsistent.");
  const retired = await context.transaction.query(
    `SELECT 1 FROM ${context.tables.content_copies} WHERE copy_key=$1 AND state IN ('retiring','retired')`,
    [body.copy.key],
  );
  if (retired.rows.length) {
    throw new Error("Protected body has entered irreversible retirement.");
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
  const keyCommand = createSchemaCommandRunner(options.session, databaseSchema);
  const dataCipher = async (transaction?: SqlExecutor, create = false) => {
    const executor = transaction ?? options.session;
    let key = await readOwnerDataKey(executor, databaseSchema);
    if (!key && create) {
      key = transaction
        ? await ensureOwnerDataKey(transaction, databaseSchema, adapter)
        : await keyCommand(
          "protected.key",
          {},
          (_input, command) =>
            ensureOwnerDataKey(command.transaction, databaseSchema, adapter),
        );
    }
    if (!key) {
      throw new Error("Owner data key is missing; run the offline migration.");
    }
    return await ownerDataCipher(databaseSchema, key, adapter);
  };
  const createId = options.createId ?? (() => crypto.randomUUID());
  const databaseStore = createDatabaseBodyStore({
    session: options.session,
    schema: databaseSchema,
  });
  const storeFor = (namespace: string): BodyStore =>
    options.storage.adapter?.forScope({ namespace, databaseSchema }) ??
      options.storage.writer ?? databaseStore;
  const staging = new Map<string, BodyStore>();
  const stagingFor = (namespace: string): BodyStore => {
    let store = staging.get(namespace);
    if (store) return store;
    const configured = storeFor(namespace);
    const target = configured.kind === "database"
      ? promotedReadyStore(configured)
      : configured;
    const database = configured.kind === "database"
      ? configured
      : databaseStore;
    store = target
      ? createPromotedBodyStore({ staging: database, ready: target })
      : database;
    staging.set(namespace, store);
    return store;
  };
  const catalog = createContentCatalog(options.session, databaseSchema);
  const physicalStore = (namespace: string, backendId: string): BodyStore => {
    const configured = storeFor(namespace);
    const staged = stagingFor(namespace);
    const target = promotedReadyStore(staged);
    const store = staged.backendId === backendId
      ? staged
      : configured.backendId === backendId
      ? configured
      : target?.backendId === backendId
      ? target
      : options.storage.readers.get(backendId);
    if (!store) throw new Error("Protected value body backend is unavailable.");
    return store;
  };
  const readerFor = (
    namespace: string,
    backendId: string,
    transaction?: SqlExecutor,
    checkRead?: () => Promise<void>,
  ): Pick<BodyStore, "readRange"> =>
    databaseBodyStoreReader(
      physicalStore(namespace, backendId),
      transaction,
      checkRead
        ? (schema) => {
          if (schema !== databaseSchema) {
            throw new Error("Protected body reader belongs to another scope.");
          }
          return checkRead();
        }
        : undefined,
    );
  const scheduled = new WeakMap<SqlExecutor, Set<string>>();
  const promote = (
    namespace: string,
    bodyId: string,
    transaction?: SqlExecutor,
  ): Promise<void> => {
    if (!promotedReadyStore(stagingFor(namespace))) return Promise.resolve();
    const publish = async () => {
      // C's existing reserve/upload/finish protocol keeps failed targets tracked
      // and leaves the committed database copy readable until promotion succeeds.
      await promoteConfiguredLogicalBody({
        catalog,
        bodyId,
        storeFor: (copy) => physicalStore(namespace, copy.backendId),
      });
    };
    if (transaction) {
      const command = schemaCommandContext(transaction, databaseSchema);
      let bodies = scheduled.get(command.transaction);
      if (!bodies) {
        bodies = new Set();
        scheduled.set(command.transaction, bodies);
      }
      if (!bodies.has(bodyId)) {
        bodies.add(bodyId);
        command.afterCommit(publish);
      }
      return Promise.resolve();
    }
    return publish();
  };

  return ({
    async prepare(coordinates, value, transaction) {
      if (transaction) {
        assertSchemaCommandTransaction(transaction, databaseSchema);
      }
      const captureCatalog = transaction
        ? createContentCatalog(transaction, databaseSchema)
        : catalog;
      const namespace = requiredText(
        coordinates.namespace,
        "Protected namespace",
      );
      const canonical = durableActionValue(value);
      const plaintext = new TextEncoder().encode(JSON.stringify(canonical));
      const aad = additionalAuthenticatedData(databaseSchema, coordinates);
      let sealed;
      try {
        sealed = await (await dataCipher(transaction, true)).seal({
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
      const configuredStore = transaction
        ? stagingFor(namespace)
        : storeFor(namespace);
      const store = transaction
        ? databaseBodyStoreWriter(configuredStore, transaction)
        : configuredStore;
      const logicalBodyId = `protected:${namespace}:${ownerNodeId}`;
      const identity = {
        bodyId: logicalBodyId,
        writerId: ownerNodeId,
        generation: 1,
      };
      await captureCatalog.reserve({
        ...identity,
        namespace,
        copy: {
          key: bodyId,
          backendKind: store.kind,
          backendId: store.backendId,
          collectable: store.conditionalDelete,
        },
      });
      if (store.kind === "database") await provisionDatabaseBodyStore(store);
      const head = await store.put({
        bodyId,
        bytes: ciphertext,
        mediaType: PROTECTED_VALUE_MEDIA_TYPE,
        digest,
        ifAbsent: true,
      });
      await captureCatalog.checkpoint({
        ...identity,
        expectedOffset: 0,
        offset: head.byteLength,
      });
      await captureCatalog.sealIntent({
        ...identity,
        length: head.byteLength,
        digest: head.digest,
      });
      await captureCatalog.sealAccepted({ ...identity, head });
      const ref = reference({
        schema: PROTECTED_VALUE_REF_SCHEMA,
        ownerNodeId,
        bodyId: logicalBodyId,
        byteLength: head.byteLength,
        digest: head.digest,
        mediaType: PROTECTED_VALUE_MEDIA_TYPE,
        commitment,
        envelope,
      });
      await promote(namespace, logicalBodyId, transaction);
      return ({
        ref,
      } as const);
    },
    async open(coordinates, rawRef, transaction) {
      const namespace = requiredText(
        coordinates.namespace,
        "Protected namespace",
      );
      const checkRead = transaction
        ? protectedValueReadCheck(transaction, { databaseSchema, namespace })
        : undefined;
      if (checkRead) await checkRead();
      else if (transaction) {
        assertSchemaCommandTransaction(transaction, databaseSchema);
      }
      const readCatalog = transaction
        ? createContentCatalog(transaction, databaseSchema)
        : catalog;
      const ref = reference(rawRef);
      const logical = await readCatalog.read(ref.bodyId);
      if (
        !logical || logical.namespace !== namespace ||
        logical.terminal?.outcome !== "completed" ||
        logical.terminal.length !== ref.byteLength ||
        logical.terminal.digest !== ref.digest
      ) throw new Error("Protected value body is inconsistent.");
      const stream = await openLogicalBody(
        readCatalog,
        ref.bodyId,
        (copy) => readerFor(namespace, copy.backendId, transaction, checkRead),
        ref.byteLength,
      );
      const ciphertext = new Uint8Array(
        await new Response(stream).arrayBuffer(),
      );
      if (await digestContent(ciphertext) !== ref.digest) {
        throw new Error("Protected value body integrity check failed.");
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await (await dataCipher(transaction)).open({
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
      if (checkRead) await checkRead();
      else if (transaction) {
        assertSchemaCommandTransaction(transaction, databaseSchema);
      }
      // Policy snapshots only read. Capture and ordinary owner reads retain the
      // existing durable promotion path; policy evaluation never schedules writes.
      if (!checkRead) await promote(namespace, ref.bodyId, transaction);
      try {
        return durableActionValue(
          JSON.parse(new TextDecoder().decode(plaintext)),
        );
      } catch {
        throw new Error("Secret recovery failed.");
      }
    },
    adopt(context, namespace, prepared) {
      assertSchemaCommandTransaction(context.transaction, databaseSchema);
      const ref = reference(prepared.ref);
      return insertOwner(
        context,
        databaseSchema,
        namespace,
        ref,
      );
    },
    project(context, namespace, rawRef) {
      return insertOwner(
        context,
        databaseSchema,
        namespace,
        reference(rawRef),
      );
    },
  } as const);
}
