import { captureOfflineManifest } from "./offline-manifest.ts";
import { authorityRequired } from "../actions/upgrade-errors.ts";
import {
  assertRetainedDataDrained,
  inspectRetainedDataDrain,
} from "../actions/drain.ts";
import { protectedActionPublicInput } from "../actions/capture-input.ts";
/** Offline v12 -> v13 upgrade. Producers must be stopped; every binding is explicit. */
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
import type { AuthenticatedAuthority, AuthorityPolicy } from "./authority.ts";
import {
  type AuthorityMigrationEntry,
  planAuthorityMigration,
  type RetainedInvocation,
  retainedMigrationAuthority,
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
    /** Reviewed attribution, distinct from the session or credential principal. */
    actorBinding?: Extract<
      import("../actions/protected-action-types.ts").ProtectedActionIngress,
      { kind: "authenticated-server" }
    >["actor"];
    ingress?:
      import("../actions/protected-action-types.ts").ProtectedActionIngress;
  })[];
}>;
async function digest(value: unknown, captured = false): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        stableStringify(captured ? value : captureHostCommandJson(value)),
      ),
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
  const invocations: RetainedInvocation[] = [],
    events: RetainedAuthorityEvent[] = [];
  for await (const batch of iterateAuthorityUpgrade(transaction, schema)) {
    invocations.push(...batch.invocations);
    events.push(...batch.events);
  }
  return { invocations, events };
}
/** Bounded inventory for CLI consumers and the v13 migration. */
export async function* iterateAuthorityUpgrade(
  transaction: SqlExecutor,
  schema: string,
) {
  const tables = createCoreTableNames(schema);
  let after: [string, string] | undefined, done = 0;
  while (true) {
    const ingress = new Map<string, Record<string, unknown>>();
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
      `WITH invoked AS MATERIALIZED (
      SELECT namespace,event_body_id FROM ${tables.event_bodies}
      WHERE COALESCE(body->'data',body)->>'status'='invoked'
    ), candidates AS MATERIALIZED (
      SELECT e.namespace,e.id FROM ${tables.events} e JOIN invoked b
        ON b.namespace=e.namespace AND b.event_body_id=e.payload->'dataRef'->>'eventBodyId'
      UNION
      SELECT namespace,id FROM ${tables.events}
        WHERE NULLIF(owner_ingress,'null'::jsonb) IS NOT NULL
          OR type IN ('copilotz.server.action.requested','copilotz.server.collection.mutation.requested')
      UNION
      SELECT e.namespace,e.id FROM ${tables.events} e JOIN
        (SELECT DISTINCT event_id FROM ${tables.event_deliveries} WHERE status IN ('pending','leased','retry_wait')) d ON d.event_id=e.id
    )
    SELECT e.namespace,e.id,e.metadata,e.payload,e.owner_ingress,b.body,b.digest,b.schema_version
    FROM candidates c JOIN ${tables.events} e ON e.id=c.id AND e.namespace=c.namespace
    LEFT JOIN ${tables.event_bodies} b ON b.namespace=e.namespace AND b.event_body_id=e.payload->'dataRef'->>'eventBodyId'
    ${after ? "WHERE (e.namespace,e.id)>($1,$2)" : ""}
    ORDER BY e.namespace,e.id LIMIT 1000`,
      after ?? [],
    )).rows;
    const receipts = (await transaction.query<
      { key: string; intent: unknown; result: unknown }
    >(
      `SELECT key,intent,result FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND kind='action.protected-input' AND key=ANY($1::text[])`,
      [rows.flatMap((row) => {
        const body = row.body ?? row.payload;
        const data = (protectedActionLifecycleBody(body)?.data ?? body) as
          | Record<string, unknown>
          | null;
        return data?.status === "invoked"
          ? [
            JSON.stringify([
              "action.protected-input",
              row.namespace,
              data.actionRunId,
            ]),
          ]
          : [];
      })],
    )).rows;
    const receiptByKey = new Map(
      receipts.map((receipt) => [receipt.key, receipt]),
    );
    const invocations: RetainedInvocation[] = [];
    const events: RetainedAuthorityEvent[] = [];
    for (const row of rows) {
      ingress.set(
        JSON.stringify([row.namespace, row.id]),
        row.owner_ingress as Record<string, unknown>,
      );
      const body = row.payload && typeof row.payload === "object" &&
          Object.hasOwn(row.payload, "dataRef")
        ? await verifiedEventBody(row, eventDataRef(row.payload))
        : captureHostCommandJson(row.payload);
      const data = (protectedActionLifecycleBody(body)?.data ?? body) as Record<
        string,
        unknown
      >;
      if (data.status === "invoked" && typeof data.actionRunId === "string") {
        const receipt = receiptByKey.get(JSON.stringify([
          "action.protected-input",
          row.namespace,
          data.actionRunId,
        ]));
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
      if (++done % 2000 === 0 || done === rows.length) {
        console.error(
          `[upgrade:${schema}] authority inventory ${done}/${rows.length}`,
        );
      }
    }
    yield { invocations, events, ingress };
    if (rows.length < 1000) break;
    after = [rows.at(-1)!.namespace, rows.at(-1)!.id];
  }
}
async function applyAuthorityUpgrade(
  transaction: SqlExecutor,
  schema: string,
  manifest: AuthorityUpgradeManifest,
): Promise<void> {
  const invocations = new Map(
    manifest.invocations.map((
      entry,
    ) => [JSON.stringify([entry.namespace, entry.runId]), entry]),
  );
  const events = new Map(
    manifest.events.map((
      entry,
    ) => [JSON.stringify([entry.namespace, entry.eventId]), entry]),
  );
  if (
    invocations.size !== manifest.invocations.length ||
    events.size !== manifest.events.length
  ) throw new Error("Duplicate authority migration entry.");
  for await (const inventory of iterateAuthorityUpgrade(transaction, schema)) {
    const selectedInvocations = inventory.invocations.map((entry) => {
      const key = JSON.stringify([entry.namespace, entry.runId]),
        selected = invocations.get(key);
      if (!selected) {
        throw new Error(
          "Retained work has no explicit authority migration or duplicate retained invocation.",
        );
      }
      invocations.delete(key);
      return selected;
    });
    const selectedEvents = inventory.events.map((entry) => {
      const key = JSON.stringify([entry.namespace, entry.eventId]),
        selected = events.get(key);
      if (!selected) {
        throw new Error(
          "Every retained ingress requires one explicit authority binding.",
        );
      }
      events.delete(key);
      return selected;
    });
    await applyAuthorityBatch(transaction, schema, {
      ...manifest,
      invocations: selectedInvocations,
      events: selectedEvents,
    }, inventory);
  }
  if (invocations.size || events.size) {
    throw new Error("Authority manifest names unknown retained work.");
  }
}
async function applyAuthorityBatch(
  transaction: SqlExecutor,
  schema: string,
  manifest: AuthorityUpgradeManifest,
  inventory: {
    invocations: RetainedInvocation[];
    events: RetainedAuthorityEvent[];
    ingress: Map<string, Record<string, unknown>>;
  },
) {
  const { ingress } = inventory;
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
  const policies = new Set(
    manifest.policies.map((policy) =>
      JSON.stringify([policy.id, policy.revision])
    ),
  );
  const updates: Record<string, unknown>[] = [];
  async function flushEvents() {
    if (!updates.length) return;
    await transaction.query(
      `UPDATE ${tables.events} e SET owner_ingress=COALESCE(NULLIF(e.owner_ingress,'null'::jsonb), v.ingress) || jsonb_build_object('authority',v.authority)
       FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,id text,authority jsonb,ingress jsonb)
       WHERE e.namespace=v.namespace AND e.id=v.id`,
      [JSON.stringify(updates)],
    );
    updates.length = 0;
  }
  let eventsDone = 0;
  for (const event of inventory.events) {
    const entry = entries.get(JSON.stringify([event.namespace, event.eventId]));
    if (!entry || entry.digest !== event.digest) {
      throw new Error("Retained ingress changed after authority review.");
    }
    const authority = retainedMigrationAuthority(entry.authority);
    if (
      authority.scope.databaseSchema !== schema ||
      authority.scope.namespace !== event.namespace ||
      !policies.has(
        JSON.stringify([authority.policy.id, authority.policy.revision]),
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
              typeof (ingress.actor as { id?: unknown }).id !== "string"
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
    const provenance = entry.ingress ??
      ingress.get(JSON.stringify([event.namespace, event.eventId]));
    if (provenance?.kind === "authenticated-server") {
      const actor = provenance.actor as Record<string, unknown> | undefined;
      if (
        !actor || Array.isArray(actor) ||
        typeof actor.id !== "string" || !actor.id.trim() ||
        Object.entries(actor).some(([key, value]) =>
          !["id", "externalId", "name", "email"].includes(key) ||
          typeof value !== "string"
        ) || !entry.actorBinding ||
        stableStringify(actor) !== stableStringify(entry.actorBinding) ||
        authority.provenance.ingress !== "http"
      ) {
        throw new Error(
          "Authenticated ingress requires an exact reviewed actor binding.",
        );
      }
    } else if (entry.actorBinding !== undefined) {
      throw new Error("Actor binding requires authenticated ingress.");
    }
    updates.push({
      namespace: event.namespace,
      id: event.eventId,
      authority,
      ingress: entry.ingress ?? null,
    });
    eventsDone++;
    if (updates.length === 2000) {
      await flushEvents();
      console.error(
        `[upgrade:${schema}] authority events ${eventsDone}/${inventory.events.length}`,
      );
    }
  }
  await flushEvents();
  console.error(
    `[upgrade:${schema}] authority events ${eventsDone}/${inventory.events.length}`,
  );
  if (inventory.events.length) {
    await transaction.query(
      `ALTER TABLE ${tables.events} ENABLE TRIGGER copilotz_events_immutable`,
    );
  }
  const invocationByKey = new Map(
    inventory.invocations.map((
      item,
    ) => [JSON.stringify([item.namespace, item.runId]), item]),
  );
  const captures: Record<string, unknown>[] = [];
  const bindings: Record<string, unknown>[] = [];
  async function flushInvocations() {
    if (captures.length) {
      await transaction.query(
        `INSERT INTO ${tables.owner_receipts}(owner,domain,key,principal,kind,intent,result)
         SELECT 'schema','logical',key,'runtime','action.protected-input',intent,result
         FROM jsonb_to_recordset($1::jsonb) AS v(key text,intent jsonb,result jsonb)`,
        [JSON.stringify(captures)],
      );
      captures.length = 0;
    }
    if (bindings.length) {
      await transaction.query(
        `INSERT INTO ${tables.authorization_invocations}(namespace,run_id,source_event_id,authority,capture,inventory_digest)
         SELECT namespace,run_id,source_event_id,authority,COALESCE(capture,'null'::jsonb),inventory_digest
         FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,run_id text,source_event_id text,authority jsonb,capture jsonb,inventory_digest text)`,
        [JSON.stringify(bindings)],
      );
      bindings.length = 0;
    }
  }
  let invocationsDone = 0;
  for (const entry of plan) {
    const invocation = invocationByKey.get(
      JSON.stringify([entry.namespace, entry.runId]),
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
      captures.push({
        key: JSON.stringify([
          "action.protected-input",
          invocation.namespace,
          invocation.runId,
        ]),
        intent: {
          databaseSchema: schema,
          namespace: invocation.namespace,
          actionId: invocation.actionId,
          inputSchema,
          publicRevisionFields: [],
        },
        result: {
          source: {
            eventId: invocation.sourceEventId,
            ...(invocation.operationId
              ? { operationId: invocation.operationId }
              : {}),
          },
          request,
        },
      });
    }
    bindings.push({
      namespace: entry.namespace,
      run_id: entry.runId,
      source_event_id: invocation.sourceEventId,
      authority: entry.authority,
      capture: entry.capture,
      inventory_digest: entry.expectedDigest,
    });
    invocationsDone++;
    if (bindings.length === 2000) {
      await flushInvocations();
      console.error(
        `[upgrade:${schema}] authority invocations ${invocationsDone}/${plan.length}`,
      );
    }
  }
  await flushInvocations();
  console.error(
    `[upgrade:${schema}] authority invocations ${invocationsDone}/${plan.length}`,
  );
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
  if (!supplied) throw authorityRequired();
  const schema = validateEventSchemaName(schemaName);
  const tables = createCoreTableNames(schema);
  const manifest = captureOfflineManifest(supplied);
  const fingerprint = await digest(manifest, true);
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
    if (version === 13 || version === 14) {
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
    assertRetainedDataDrained(
      await inspectRetainedDataDrain(transaction, schema),
    );
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
