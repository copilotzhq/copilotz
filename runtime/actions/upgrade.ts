import {
  type UnrecoverableDecisions,
  verifyUnrecoverableDecisions,
} from "../content/unrecoverable.ts";
import {
  type AbandonmentDecisions,
  recordRetainedTerminals,
  type RetainedTerminals,
  verifyAbandonmentDecisions,
} from "./upgrade-terminals.ts";
import { bodyStoreReader } from "./owner-transfer-storage.ts";
import { upgradeCredentialEffects } from "../authorization/credentials-upgrade.ts";
import { migrateOwnerKeys } from "./migrate-owner-keys.ts";
import { authorityRequired, ownerKeysRequired } from "./upgrade-errors.ts";
import {
  type AuthorityUpgradeManifest,
  upgradeAuthoritySchema,
} from "../authorization/upgrade.ts";
import {
  assertReceiptUpgradeAuthority,
  upgradeReceiptReaders,
} from "./upgrade-receipts.ts";
import {
  createCoreSchemaStatements,
  createCoreTableNames,
  createOwnerSchemaStatements,
  createOwnerSequenceStatements,
  EVENT_SCHEMA_VERSION,
  quoteEventIdentifier,
  validateCopilotzSchema,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  upgradeOperationCatalog,
  validateOperationCatalog,
} from "../streams/catalog.ts";
import {
  migrateBodyStoreSchema,
  validateBodyStoreSchema,
} from "../content/body-store-schema.ts";
import { createDatabaseBodyStore } from "../content/database-body-store.ts";
import type { BodyStore } from "../content/body-store.ts";
import { digestContent } from "../content/digest.ts";
import {
  type ContentMigrationPlan,
  type EmbeddedBodyLocation,
  inspectEmbeddedContent,
  migrateEmbeddedContent,
} from "../content/migration.ts";
import {
  type ContentMigrationDecision,
  type ContentMigrationReport,
  migrateActionContent,
} from "./content-migration.ts";
import {
  assertRetainedDataDrained,
  inspectRetainedDataDrain,
} from "./drain.ts";
import { validateRetainedHistory } from "./upgrade-history.ts";

export type RetainedDataUpgradeStorage = Readonly<{
  abandoned?: AbandonmentDecisions;
  unrecoverable?: UnrecoverableDecisions;
  /** Resolve only the explicit backend identity in the reviewed inventory. */
  storeFor?: (
    location: EmbeddedBodyLocation,
    session: SqlSession,
  ) => BodyStore | undefined;
  /** Bounded content head/digest parallelism; defaults to 16. */
  concurrency?: number;
  streamBackend?: Readonly<{ kind: string; backendId: string }>;
  copyMappings?: Parameters<typeof inspectEmbeddedContent>[0]["copyMappings"];
}>;
export type RetainedDataUpgradePlan = Readonly<{
  schema: string;
  id: string;
  sourceVersion: number;
  targetVersion: number;
  content: ContentMigrationPlan;
  ownership: ContentMigrationReport;
  terminals?: RetainedTerminals;
  fingerprint: string;
}>;
const RETAINED_TARGET_VERSION = 11;

export type OwnerKeyUpgradeOptions = Omit<
  Parameters<typeof migrateOwnerKeys>[0],
  "session" | "schema"
>;

type Marker = {
  version: number | string;
  upgrade_from?: number | string | null;
  upgrade_to?: number | string | null;
  upgrade_id?: string | null;
  upgrade_reviewed_fingerprint?: string | null;
  upgrade_decisions_fingerprint?: string | null;
};

function joined(transaction: SqlExecutor): SqlSession {
  return { query: transaction.query, transaction: (run) => run(transaction) };
}
async function lockSchema(transaction: SqlExecutor, schema: string) {
  const tables = (await transaction.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name",
    [schema],
  )).rows;
  if (!tables.length) {
    throw new Error("Retained-data upgrade requires an existing schema.");
  }
  await transaction.query(
    `LOCK TABLE ${
      tables.map(({ table_name }) =>
        `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table_name)}`
      ).join(", ")
    } IN ACCESS EXCLUSIVE MODE`,
  );
}
async function marker(
  transaction: SqlExecutor,
  schema: string,
): Promise<Marker> {
  const rows = (await transaction.query<Marker>(
    `SELECT * FROM ${
      createCoreTableNames(schema).copilotz_schema_metadata
    } WHERE singleton`,
  )).rows;
  if (rows.length !== 1) {
    throw new Error("Upgrade requires one exact schema marker.");
  }
  return rows[0];
}
function assertInterrupted(value: Marker) {
  if (
    Number(value.version) !== 0 || !value.upgrade_id ||
    !Number.isInteger(Number(value.upgrade_from)) ||
    Number(value.upgrade_from) < 5 ||
    Number(value.upgrade_from) >= RETAINED_TARGET_VERSION ||
    Number(value.upgrade_to) !== RETAINED_TARGET_VERSION ||
    value.upgrade_reviewed_fingerprint != null ||
    value.upgrade_decisions_fingerprint != null
  ) {
    throw new Error(
      "Interrupted upgrade marker is missing or belongs to a different release.",
    );
  }
}
export function retainedContentInspector(
  session: SqlSession,
  schema: string,
  storage: RetainedDataUpgradeStorage,
) {
  const database = createDatabaseBodyStore({
    session,
    schema,
    provisioned: true,
  });
  return {
    session,
    schema,
    streamBackend: storage.streamBackend ??
      { kind: "database", backendId: "database:default" },
    copyMappings: storage.copyMappings,
    concurrency: storage.concurrency,
    unrecoverable: storage.unrecoverable,
    ...(storage.storeFor ? {} : { nativeDatabase: session }),
    storeFor: (location: EmbeddedBodyLocation) => {
      const selected = storage.storeFor?.(location, session);
      if (selected !== undefined) return selected;
      if (
        location.kind !== "database" ||
        location.backendId !== database.backendId
      ) {
        throw new Error(
          `Select the retained content backend explicitly: ${location.kind}/${location.backendId}.`,
        );
      }
      return database;
    },
  };
}
async function fingerprint(plan: Omit<RetainedDataUpgradePlan, "fingerprint">) {
  return await digestContent(new TextEncoder().encode(JSON.stringify({
    schema: plan.schema,
    id: plan.id,
    sourceVersion: plan.sourceVersion,
    targetVersion: plan.targetVersion,
    content: plan.content,
    ownership: plan.ownership,
    ...(plan.terminals ? { terminals: plan.terminals } : {}),
  })));
}

function canonicalDecisions(
  decisions: readonly ContentMigrationDecision[] | undefined,
): ContentMigrationDecision[] {
  if (decisions !== undefined && !Array.isArray(decisions)) {
    throw new TypeError("Content migration decisions must be an array.");
  }
  return (decisions ?? []).map((decision) => {
    if (
      !decision || typeof decision.namespace !== "string" ||
      typeof decision.assetId !== "string" ||
      (decision.ownerId !== null && typeof decision.ownerId !== "string")
    ) {
      throw new TypeError(
        "Content migration decisions require an explicit owner or null.",
      );
    }
    return {
      namespace: decision.namespace,
      assetId: decision.assetId,
      ownerId: decision.ownerId,
    };
  }).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * One offline upgrade, preparation phase. Intake and all old producers must be
 * stopped. Physical conversion commits once, then version 0 bars either runtime
 * from activating. Inspect/review the returned inventory before finalization.
 * A lost response or failed inventory is resumed by calling this again; actual
 * committed physical version tokens and the upgrade identity are preserved.
 */
export async function prepareRetainedDataUpgrade(
  session: SqlSession,
  schemaName = "public",
  storage: RetainedDataUpgradeStorage = {},
): Promise<RetainedDataUpgradePlan | undefined> {
  storage = {
    ...storage,
    unrecoverable: await verifyUnrecoverableDecisions(
      structuredClone(storage.unrecoverable),
    ),
    abandoned: await verifyAbandonmentDecisions(
      structuredClone(storage.abandoned),
    ),
  };
  let terminals: RetainedTerminals | undefined;
  const schema = validateEventSchemaName(schemaName);
  const metadata = createCoreTableNames(schema).copilotz_schema_metadata;
  const prepared = await session.transaction(async (transaction) => {
    await lockSchema(transaction, schema);
    const current = await marker(transaction, schema);
    if (Number(current.version) === EVENT_SCHEMA_VERSION) {
      await validateCopilotzSchema(transaction, schema);
      await validateOperationCatalog(joined(transaction), schema);
      return undefined;
    }
    if (Number(current.version) === 11) throw ownerKeysRequired();
    if (Number(current.version) === 12) {
      throw authorityRequired();
    }
    if (Number(current.version) === 0) {
      assertInterrupted(current);
      assertRetainedDataDrained(
        await inspectRetainedDataDrain(transaction, schema),
      );
      await validateBodyStoreSchema(transaction, schema);
      terminals = await validateRetainedHistory(
        transaction,
        schema,
        storage.abandoned,
      );
      return current;
    }
    if (
      !Number.isInteger(Number(current.version)) ||
      Number(current.version) < 5 ||
      Number(current.version) >= RETAINED_TARGET_VERSION
    ) {
      throw new Error(
        "Retained-data upgrade requires a supported pre-conversion or owner schema baseline.",
      );
    }
    assertRetainedDataDrained(
      await inspectRetainedDataDrain(transaction, schema),
    );
    terminals = await validateRetainedHistory(
      transaction,
      schema,
      storage.abandoned,
    );
    await assertReceiptUpgradeAuthority(transaction, schema);
    await migrateBodyStoreSchema(joined(transaction), schema);
    await transaction.query(
      `ALTER TABLE ${metadata} ADD COLUMN IF NOT EXISTS upgrade_from INTEGER, ADD COLUMN IF NOT EXISTS upgrade_to INTEGER, ADD COLUMN IF NOT EXISTS upgrade_id TEXT, ADD COLUMN IF NOT EXISTS upgrade_reviewed_fingerprint TEXT, ADD COLUMN IF NOT EXISTS upgrade_decisions_fingerprint TEXT`,
    );
    const id = crypto.randomUUID();
    const updated = await transaction.query<Marker>(
      `UPDATE ${metadata} SET version=0,upgrade_from=$1,upgrade_to=$2,upgrade_id=$3,upgrade_reviewed_fingerprint=NULL,upgrade_decisions_fingerprint=NULL WHERE singleton AND version=$1 RETURNING *`,
      [Number(current.version), RETAINED_TARGET_VERSION, id],
    );
    if (updated.rows.length !== 1) {
      throw new Error("Upgrade source marker changed.");
    }
    return updated.rows[0];
  });
  if (!prepared) return undefined;
  const content = await inspectEmbeddedContent(
    retainedContentInspector(session, schema, storage),
  );
  const ownership = await migrateActionContent(session, schema);
  const plan = {
    schema,
    id: prepared.upgrade_id!,
    sourceVersion: Number(prepared.upgrade_from),
    targetVersion: Number(prepared.upgrade_to),
    content,
    ownership,
    ...(terminals ? { terminals } : {}),
  };
  return { ...plan, fingerprint: await fingerprint(plan) };
}

/**
 * Finalize the sole retained-data upgrade. The exact reviewed preparation is
 * revalidated inside the final transaction before any readiness marker changes.
 * Calling without a plan remains convenient only for schemas with no content to
 * review. Populated schemas must use prepareRetainedDataUpgrade first.
 */
async function finalizeRetainedDataUpgrade(
  session: SqlSession,
  schemaName = "public",
  options:
    & RetainedDataUpgradeStorage
    & Readonly<{
      plan?: RetainedDataUpgradePlan;
      reviewedFingerprint?: string;
      contentDecisions?: readonly ContentMigrationDecision[];
      ownerKeys?: OwnerKeyUpgradeOptions;
      authority?: AuthorityUpgradeManifest;
    }> = {},
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  const core = createCoreTableNames(schema);
  const currentVersion = Number(
    (await session.query<{ version: number }>(
      `SELECT version FROM ${core.copilotz_schema_metadata} WHERE singleton`,
    )).rows[0]?.version,
  );
  if (
    currentVersion >= 11 && currentVersion <= EVENT_SCHEMA_VERSION &&
    !options.plan
  ) {
    if (
      options.reviewedFingerprint !== undefined ||
      options.contentDecisions !== undefined ||
      options.abandoned !== undefined || options.unrecoverable !== undefined
    ) {
      throw new Error(
        "Reviewed upgrade options require the original retained-data plan.",
      );
    }
    return;
  }
  // Snapshot accepted intent before any asynchronous inventory or SQL work.
  const decisions = canonicalDecisions(options.contentDecisions);
  const abandoned = await verifyAbandonmentDecisions(options.abandoned);
  const unrecoverable = await verifyUnrecoverableDecisions(
    options.unrecoverable,
  );
  // The public entry point already detached the plan before its first await.
  let plan = options.plan;
  const reviewedFingerprint = options.reviewedFingerprint;
  const hasReviewedIntent = reviewedFingerprint !== undefined ||
    options.contentDecisions !== undefined || options.abandoned !== undefined ||
    options.unrecoverable !== undefined;
  const decisionsFingerprint = await digestContent(
    new TextEncoder().encode(
      JSON.stringify(
        unrecoverable?.entries.length
          ? { content: decisions, abandoned, unrecoverable }
          : abandoned?.entries.length
          ? { content: decisions, abandoned }
          : decisions,
      ),
    ),
  );
  if (!plan) {
    if (hasReviewedIntent) {
      throw new Error(
        "Reviewed upgrade options require the original retained-data plan.",
      );
    }
    plan = await prepareRetainedDataUpgrade(session, schema, options);
    if (!plan) return;
    if (
      plan.content.inventory.length || plan.ownership.executionOwners ||
      plan.terminals
    ) {
      throw Object.assign(
        new Error(
          "Review the prepared retained-content inventory before finalizing the offline upgrade.",
        ),
        { code: "copilotz_upgrade_review_required", plan },
      );
    }
  } else if (reviewedFingerprint !== plan.fingerprint) {
    throw new Error(
      "The exact retained-data inventory fingerprint must be reviewed.",
    );
  }
  if (
    plan.schema !== schema || plan.targetVersion !== RETAINED_TARGET_VERSION ||
    await fingerprint(plan) !== plan.fingerprint
  ) {
    throw new Error(
      "Retained-data upgrade plan is mixed, changed, or for a different schema/release.",
    );
  }
  const reviewed = plan;
  await session.transaction(async (transaction) => {
    await lockSchema(transaction, schema);
    const current = await marker(transaction, schema);
    if (
      current.upgrade_id !== reviewed.id ||
      Number(current.upgrade_from) !== reviewed.sourceVersion ||
      Number(current.upgrade_to) !== reviewed.targetVersion
    ) {
      throw new Error(
        "Retained-data upgrade identity does not match its prepared source.",
      );
    }
    if (
      Number(current.version) >= 11 &&
      Number(current.version) <= EVENT_SCHEMA_VERSION
    ) {
      if (
        current.upgrade_reviewed_fingerprint !== reviewed.fingerprint ||
        current.upgrade_decisions_fingerprint !== decisionsFingerprint
      ) {
        throw new Error(
          "Completed upgrade replay differs from the accepted plan or ownership decisions.",
        );
      }
      await validateOperationCatalog(joined(transaction), schema);
      await validateBodyStoreSchema(transaction, schema);
      return;
    }
    assertInterrupted(current);
    assertRetainedDataDrained(
      await inspectRetainedDataDrain(transaction, schema),
    );
    const terminals = await validateRetainedHistory(
      transaction,
      schema,
      abandoned,
    );
    if (JSON.stringify(terminals) !== JSON.stringify(reviewed.terminals)) {
      throw new Error(
        "Retained terminal evidence or abandonment decisions changed after review.",
      );
    }
    await assertReceiptUpgradeAuthority(transaction, schema);
    const session = joined(transaction);
    const actual = await inspectEmbeddedContent(
      retainedContentInspector(session, schema, options),
    );
    const ownership = await migrateActionContent(session, schema);
    if (
      actual.fingerprint !== reviewed.content.fingerprint ||
      JSON.stringify(ownership) !== JSON.stringify(reviewed.ownership)
    ) {
      throw new Error(
        "Retained bytes, physical versions, or ownership changed after review.",
      );
    }
    if (reviewed.sourceVersion >= 6 && reviewed.sourceVersion <= 7) {
      await transaction.query(`DROP TABLE ${core.open_actions}`);
    }
    if (reviewed.sourceVersion === 5) {
      await transaction.query(
        `ALTER TABLE ${core.event_deliveries} ADD COLUMN IF NOT EXISTS action_scope_id TEXT`,
      );
    }
    for (
      const statement of [
        ...createOwnerSchemaStatements(schema, { version: 11 }),
        ...createOwnerSequenceStatements(schema),
        ...createCoreSchemaStatements(schema, { ownerVersion: 11 }),
      ]
    ) {
      await transaction.query(statement);
    }
    // CREATE TABLE IF NOT EXISTS cannot add the v11 ingress capture to history.
    await transaction.query(
      `ALTER TABLE ${core.events} ADD COLUMN IF NOT EXISTS owner_ingress JSONB`,
    );
    await upgradeReceiptReaders(transaction, schema);
    await migrateEmbeddedContent({
      session,
      plan: actual,
      drained: true,
      reviewedFingerprint: actual.fingerprint,
    });
    await migrateActionContent(session, schema, {
      apply: true,
      decisions,
    });
    await upgradeOperationCatalog(session, schema);
    await validateRetainedHistory(transaction, schema, abandoned);
    await recordRetainedTerminals(
      transaction,
      schema,
      terminals,
      reviewed.fingerprint,
    );
    await assertReceiptUpgradeAuthority(transaction, schema);
    const updated = await transaction.query(
      `UPDATE ${core.copilotz_schema_metadata} SET version = $1,upgrade_reviewed_fingerprint=$4,upgrade_decisions_fingerprint=$5 WHERE singleton AND version=0 AND upgrade_id=$2 AND upgrade_from=$3 AND upgrade_to=$1 AND upgrade_reviewed_fingerprint IS NULL AND upgrade_decisions_fingerprint IS NULL RETURNING version`,
      [
        RETAINED_TARGET_VERSION,
        reviewed.id,
        reviewed.sourceVersion,
        reviewed.fingerprint,
        decisionsFingerprint,
      ],
    );
    if (updated.rows.length !== 1) {
      throw new Error("Upgrade final marker changed.");
    }
    await validateOperationCatalog(session, schema);
    await validateBodyStoreSchema(transaction, schema);
  });
}

/** Run only the next step: retained data -> v11 -> owner keys v12 -> authority v13 -> credential effects and flow admission v14.
 * Each committed checkpoint can be resumed after missing input or a lost response.
 */
export async function upgradeActionLifecycle(
  session: SqlSession,
  schemaName = "public",
  options: Parameters<typeof finalizeRetainedDataUpgrade>[2] = {},
): Promise<void> {
  // Preserve the reviewed intent across every asynchronous checkpoint.
  options = {
    ...options,
    ...(options.unrecoverable
      ? { unrecoverable: structuredClone(options.unrecoverable) }
      : {}),
    ...(options.abandoned
      ? { abandoned: structuredClone(options.abandoned) }
      : {}),
    ...(options.plan ? { plan: structuredClone(options.plan) } : {}),
    ...(options.contentDecisions
      ? { contentDecisions: structuredClone(options.contentDecisions) }
      : {}),
    ...(options.authority
      ? { authority: structuredClone(options.authority) }
      : {}),
    ...(options.ownerKeys ? { ownerKeys: { ...options.ownerKeys } } : {}),
  };
  const schema = validateEventSchemaName(schemaName);
  await finalizeRetainedDataUpgrade(session, schema, options);
  const version = Number((await marker(session, schema)).version);
  if (version === 11) {
    if (
      !options.ownerKeys?.sourceAdapter || !options.ownerKeys?.masterAdapter
    ) {
      throw ownerKeysRequired();
    }
    const readExternalBody = options.ownerKeys.readExternalBody ??
      (options.storeFor
        ? (
          copy: Parameters<
            NonNullable<OwnerKeyUpgradeOptions["readExternalBody"]>
          >[0],
        ) =>
          bodyStoreReader(() =>
            retainedContentInspector(session, schema, options).storeFor({
              namespace: copy.namespace,
              kind: copy.kind ?? "object",
              backendId: copy.backendId,
              key: copy.key,
            })
          )(copy)
        : undefined);
    await migrateOwnerKeys({
      ...options.ownerKeys,
      readExternalBody,
      session,
      schema,
    });
  }
  if (version === 11 || version === 12 || options.authority) {
    await upgradeAuthoritySchema(session, schema, options.authority);
  }
  await upgradeCredentialEffects(session, schema);
  await validateCopilotzSchema(session, schema);
  await validateOperationCatalog(session, schema);
}
