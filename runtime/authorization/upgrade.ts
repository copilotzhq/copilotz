import { protectedActionPublicInput } from "../actions/capture-input.ts";
/** Offline v11 -> v12 upgrade. Producers must be stopped; every binding is explicit. */
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../events/schema.ts";
import { eventDataRef, verifiedEventBody } from "../events/body-store.ts";
import { protectedActionLifecycleBody } from "../actions/protected-lifecycle.ts";
import { stableStringify } from "../collections/equal.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import {
  type AuthenticatedAuthority,
  type AuthorityPolicy,
  retainedAuthority,
} from "./authority.ts";
import {
  type AuthorityMigrationEntry,
  planAuthorityMigration,
  type RetainedInvocation,
} from "./migration.ts";
import { authorizationSchemaStatements } from "./schema.ts";

export type RetainedAuthorityEvent = Readonly<
  { namespace: string; eventId: string; digest: string; unclassified?: boolean }
>;
export type AuthorityUpgradeManifest = Readonly<{
  actionSchemas?: Readonly<
    Record<string, import("../actions/types.ts").ActionSchema | null>
  >;
  policies: readonly AuthorityPolicy[];
  invocations: readonly AuthorityMigrationEntry[];
  events: readonly (RetainedAuthorityEvent & {
    authority: AuthenticatedAuthority;
    ingress?:
      import("../actions/protected-action-types.ts").ProtectedActionIngress;
  })[];
}>;
async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stableStringify(captureHostCommandJson(value))),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function inspectAuthorityUpgrade(
  transaction: SqlExecutor,
  schema: string,
): Promise<
  Readonly<{
    invocations: readonly RetainedInvocation[];
    events: readonly RetainedAuthorityEvent[];
  }>
> {
  const tables = createCoreTableNames(schema);
  const rows = (await transaction.query<{
    namespace: string;
    id: string;
    metadata: Record<string, unknown>;
    payload: unknown;
    owner_ingress: unknown;
    body: unknown;
    digest: string;
    schema_version: number;
    intent: unknown;
    result: unknown;
  }>(
    `SELECT e.namespace,e.id,e.metadata,e.payload,e.owner_ingress,b.body,b.digest,b.schema_version
    FROM ${tables.events} e LEFT JOIN ${tables.event_bodies} b ON b.namespace=e.namespace AND b.event_body_id=e.payload->'dataRef'->>'eventBodyId'
    WHERE COALESCE(b.body->'data',b.body)->>'status'='invoked' OR e.owner_ingress IS NOT NULL OR e.type IN ('copilotz.server.action.requested','copilotz.server.collection.mutation.requested') OR EXISTS (SELECT 1 FROM ${tables.event_deliveries} d WHERE d.event_id=e.id AND d.status IN ('pending','leased','retry_wait'))
    ORDER BY e.namespace,e.id`,
  )).rows;
  const receipts =
    (await transaction.query<{ key: string; intent: unknown; result: unknown }>(
      `SELECT key,intent,result FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND kind='action.protected-input'`,
    )).rows;
  const invocations: RetainedInvocation[] = [];
  const events: RetainedAuthorityEvent[] = [];
  for (const row of rows) {
    const body = row.payload && typeof row.payload === "object" &&
        Object.hasOwn(row.payload, "dataRef")
      ? await verifiedEventBody(row, eventDataRef(row.payload))
      : captureHostCommandJson(row.payload);
    const data = (protectedActionLifecycleBody(body)?.data ?? body) as Record<
      string,
      unknown
    >;
    if (data.status === "invoked" && typeof data.actionRunId === "string") {
      const receipt = receipts.find((receipt) =>
        receipt.key ===
          JSON.stringify([
            "action.protected-input",
            row.namespace,
            data.actionRunId,
          ])
      );
      const capture = receipt
        ? { intent: receipt.intent, result: receipt.result } as NonNullable<
          RetainedInvocation["capture"]
        >
        : null;
      const sourceEventId = capture?.result.source.eventId ??
        row.metadata.sourceEventId;
      if (typeof sourceEventId !== "string" || !sourceEventId) {
        throw new Error(
          "Retained invocation source is missing; authority cannot be inferred.",
        );
      }
      invocations.push({
        databaseSchema: schema,
        namespace: row.namespace,
        runId: data.actionRunId,
        actionId: String(data.actionId),
        sourceEventId,
        operationId: capture?.result.source.operationId ?? null,
        parentRunId: typeof data.parentActionRunId === "string"
          ? data.parentActionRunId
          : null,
        body,
        capture,
      });
    } else {
      events.push({
        namespace: row.namespace,
        eventId: row.id,
        ...(row.owner_ingress === null ? { unclassified: true } : {}),
        digest: await digest({
          namespace: row.namespace,
          id: row.id,
          metadata: row.metadata,
          payload: row.payload,
          ownerIngress: row.owner_ingress,
          body,
        }),
      });
    }
  }
  return { invocations, events };
}
export async function applyAuthorityUpgrade(
  transaction: SqlExecutor,
  schema: string,
  supplied?: AuthorityUpgradeManifest,
): Promise<void> {
  const inventory = await inspectAuthorityUpgrade(transaction, schema);
  const manifest = supplied
    ? captureHostCommandJson(supplied) as AuthorityUpgradeManifest
    : { policies: [], invocations: [], events: [] };
  const plan = await planAuthorityMigration(
    inventory.invocations,
    manifest.invocations,
    manifest.policies,
  );
  const entries = new Map(
    manifest.events.map((
      entry,
    ) => [JSON.stringify([entry.namespace, entry.eventId]), entry]),
  );
  if (
    entries.size !== manifest.events.length ||
    entries.size !== inventory.events.length
  ) {
    throw new Error(
      "Every retained ingress requires one explicit authority binding.",
    );
  }
  const tables = createCoreTableNames(schema);
  for (const statement of authorizationSchemaStatements(schema)) {
    await transaction.query(statement);
  }
  if (inventory.events.length) {
    await transaction.query(
      `ALTER TABLE ${tables.events} DISABLE TRIGGER copilotz_events_immutable`,
    );
  }
  for (const event of inventory.events) {
    const entry = entries.get(JSON.stringify([event.namespace, event.eventId]));
    if (!entry || entry.digest !== event.digest) {
      throw new Error("Retained ingress changed after authority review.");
    }
    const authority = retainedAuthority(entry.authority);
    if (
      authority.scope.databaseSchema !== schema ||
      authority.scope.namespace !== event.namespace ||
      !manifest.policies.some((policy) =>
        policy.id === authority.policy.id &&
        policy.revision === authority.policy.revision
      )
    ) throw new Error("Retained ingress authority scope or policy is invalid.");
    if (event.unclassified && !entry.ingress) {
      throw new Error(
        "Unclassified ingress requires an explicit provenance migration.",
      );
    }
    if (entry.ingress) {
      if (!event.unclassified) {
        throw new Error("Classified ingress provenance cannot be replaced.");
      }
      const ingress = captureHostCommandJson(entry.ingress) as Record<
        string,
        unknown
      >;
      const fields: Record<string, readonly string[]> = {
        host: [],
        "server-route": ["routeId"],
        "authenticated-server": ["actor"],
        "scheduled-occurrence": [
          "scheduleId",
          "occurrenceId",
          "scheduledFor",
          "scheduleVersion",
        ],
      };
      const required = fields[String(ingress.kind)];
      if (
        !required || Object.keys(ingress).some((key) =>
          key !== "kind" && !required.includes(key)
        ) ||
        required.some((key) =>
          key === "actor"
            ? !ingress.actor || typeof ingress.actor !== "object" ||
              typeof (ingress.actor as { id?: unknown }).id !== "string" ||
              (ingress.actor as { id: string }).id !== authority.principal.id
            : typeof ingress[key] !== "string" ||
              !(ingress[key] as string).trim()
        )
      ) {
        throw new Error("Migrated ingress provenance is invalid.");
      }
      if (
        (ingress.kind === "scheduled-occurrence" &&
          authority.provenance.ingress !== "alarm") ||
        (["server-route", "authenticated-server"].includes(
          String(ingress.kind),
        ) && authority.provenance.ingress !== "http")
      ) {
        throw new Error(
          "Migrated ingress does not match its authority provenance.",
        );
      }
    }
    await transaction.query(
      `UPDATE ${tables.events} SET owner_ingress=COALESCE(owner_ingress, $4::jsonb) || jsonb_build_object('authority',$3::jsonb) WHERE namespace=$1 AND id=$2`,
      [
        event.namespace,
        event.eventId,
        JSON.stringify(authority),
        JSON.stringify(entry.ingress ?? null),
      ],
    );
  }
  if (inventory.events.length) {
    await transaction.query(
      `ALTER TABLE ${tables.events} ENABLE TRIGGER copilotz_events_immutable`,
    );
  }
  for (const entry of plan) {
    const invocation = inventory.invocations.find((item) =>
      item.namespace === entry.namespace && item.runId === entry.runId
    )!;
    if (!entry.capture) {
      if (
        !manifest.actionSchemas ||
        !Object.hasOwn(manifest.actionSchemas, invocation.actionId)
      ) {
        throw new Error(
          "Unbound retained captures require an explicit Action schema snapshot.",
        );
      }
      const inputSchema = manifest.actionSchemas[invocation.actionId];
      const data = (protectedActionLifecycleBody(invocation.body)?.data ??
        invocation.body) as { input: unknown };
      const request = protectedActionPublicInput({
        id: invocation.actionId,
        ...(inputSchema ? { inputSchema } : {}),
        execute: () => undefined,
      }, data.input);
      await transaction.query(
        `INSERT INTO ${tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical',$1,'runtime','action.protected-input',$2::jsonb,$3::jsonb)`,
        [
          JSON.stringify([
            "action.protected-input",
            invocation.namespace,
            invocation.runId,
          ]),
          JSON.stringify({
            databaseSchema: schema,
            namespace: invocation.namespace,
            actionId: invocation.actionId,
            inputSchema,
            publicRevisionFields: [],
          }),
          JSON.stringify({
            source: {
              eventId: invocation.sourceEventId,
              ...(invocation.operationId
                ? { operationId: invocation.operationId }
                : {}),
            },
            request,
          }),
        ],
      );
    }
    await transaction.query(
      `INSERT INTO ${tables.authorization_invocations}(namespace,run_id,source_event_id,authority,capture,inventory_digest) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        entry.namespace,
        entry.runId,
        invocation.sourceEventId,
        JSON.stringify(entry.authority),
        JSON.stringify(entry.capture),
        entry.expectedDigest,
      ],
    );
  }
  // Transport instances never survive the offline cutover; clients reattach.
  await transaction.query(`DELETE FROM ${tables.authorization_channels}`);
  await transaction.query(
    `DELETE FROM ${tables.owner_deadlines} WHERE source='authorization'`,
  );
}
export async function upgradeAuthoritySchema(
  session: SqlSession,
  schemaName: string,
  supplied?: AuthorityUpgradeManifest,
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  const tables = createCoreTableNames(schema);
  const manifest = supplied
    ? captureHostCommandJson(supplied) as AuthorityUpgradeManifest
    : undefined;
  const fingerprint = await digest(
    manifest ?? { policies: [], invocations: [], events: [] },
  );
  await session.transaction(async (transaction) => {
    const names = (await transaction.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name",
      [schema],
    )).rows;
    await transaction.query(
      `LOCK TABLE ${
        names.map((row) =>
          `${quoteEventIdentifier(schema)}.${
            quoteEventIdentifier(row.table_name)
          }`
        ).join(",")
      } IN ACCESS EXCLUSIVE MODE`,
    );
    const version = Number(
      (await transaction.query<{ version: number }>(
        `SELECT version FROM ${tables.copilotz_schema_metadata} WHERE singleton`,
      )).rows[0]?.version,
    );
    if (version === 13) {
      const receipt = (await transaction.query<{ intent: unknown }>(
        `SELECT intent FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND key='authorization-upgrade:13'`,
      )).rows[0];
      if (
        !receipt ||
        stableStringify(receipt.intent) !== stableStringify({ fingerprint })
      ) {
        throw new Error(
          "Authority upgrade replay differs from its accepted manifest.",
        );
      }
      return;
    }
    if (version !== 12) {
      throw new Error("Authority upgrade requires schema version 12.");
    }
    await applyAuthorityUpgrade(transaction, schema, manifest);
    await transaction.query(
      `INSERT INTO ${tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical','authorization-upgrade:13','offline-upgrade','authorization.upgrade',$1::jsonb,'null')`,
      [JSON.stringify({ fingerprint })],
    );
    await transaction.query(
      `UPDATE ${tables.owner_epochs} SET epoch=epoch+1,holder=''`,
    );
    await transaction.query(
      `UPDATE ${tables.copilotz_schema_metadata} SET version=13 WHERE singleton AND version=12`,
    );
  });
}
