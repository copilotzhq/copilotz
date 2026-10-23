/** Offline v11 -> v12 conversion. Never invoked by runtime activation. */
import type { SqlSession } from "../events/session.ts";
import {
  createCoreTableNames,
  createOwnerDataKeyStatements,
  quoteEventIdentifier,
} from "../events/schema.ts";
import {
  assertRetainedDataDrained,
  inspectRetainedDataDrain,
} from "./drain.ts";
import { ensureOwnerDataKey, ownerDataCipher } from "./owner-data-key.ts";
import {
  additionalAuthenticatedData,
  PROTECTED_VALUE_REF_SCHEMA,
  type ProtectedValueCoordinates,
  type ProtectedValueRef,
  protectedValueRef,
} from "./protected-value.ts";
import type { SecretAdapter } from "./secret-adapter.ts";
import { encodeEventBody } from "../events/body-store.ts";
import { base64ToBytes, bytesToBase64 } from "../content/encoding.ts";
import { digestContent } from "../content/digest.ts";
import {
  type BodyReader,
  installTransferBodies,
  iterateTransferBodies,
  lockOwnerTables,
  type TransferBody,
} from "./owner-transfer-storage.ts";

export type ProtectedBinding = ProtectedValueCoordinates & {
  ref: ProtectedValueRef;
};
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function visit(value: unknown, fn: (value: Record<string, unknown>) => void) {
  if (Array.isArray(value)) { for (const entry of value) visit(entry, fn); }
  else {
    const row = object(value);
    if (row) {
      fn(row);
      for (const entry of Object.values(row)) visit(entry, fn);
    }
  }
}
/** Every retained reference must be classifiable; custom captures need explicit bindings. */
export async function migrateOwnerKeys(input: {
  session: SqlSession;
  schema: string;
  sourceAdapter: SecretAdapter;
  masterAdapter: SecretAdapter;
  bindings?: readonly ProtectedBinding[];
  readExternalBody?: BodyReader;
}): Promise<{ protectedValues: number; bodies: number }> {
  const { session, schema } = input, tables = createCoreTableNames(schema);
  return await session.transaction(async (tx) => {
    await lockOwnerTables(tx, schema, "ACCESS EXCLUSIVE");
    const version = (await tx.query<{ version: number }>(
      `SELECT version FROM ${tables.copilotz_schema_metadata} WHERE singleton`,
    )).rows[0]?.version;
    if ([12, 13, 14].includes(Number(version))) {
      const receipt = (await tx.query<
        { result: { protectedValues: number; bodies: number } }
      >(
        `SELECT result FROM ${tables.owner_receipts} WHERE owner='schema' AND domain='logical' AND key='owner-keys-upgrade:12'`,
      )).rows[0];
      if (!receipt) throw new Error("Owner key upgrade receipt is missing.");
      return receipt.result;
    }
    if (Number(version) !== 11) {
      throw new Error("Owner key migration requires schema v11.");
    }
    assertRetainedDataDrained(await inspectRetainedDataDrain(tx, schema));
    const columns =
      (await tx.query<{ table_name: string; column_name: string }>(
        `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND data_type IN ('json','jsonb') ORDER BY table_name,column_name`,
        [schema],
      )).rows;
    const cells: {
      table: string;
      column: string;
      rows: { tid: string; value: unknown; namespace?: string }[];
    }[] = [];
    const refs = new Map<string, ProtectedValueRef>(),
      bindings = new Map<string, ProtectedBinding>();
    const bind = (binding: ProtectedBinding) => {
      const old = bindings.get(binding.ref.bodyId);
      if (
        old &&
        JSON.stringify([old.namespace, old.ownerId, old.slot]) !==
          JSON.stringify([binding.namespace, binding.ownerId, binding.slot])
      ) throw new Error("Conflicting protected coordinates.");
      bindings.set(binding.ref.bodyId, binding);
    };
    for (const binding of input.bindings ?? []) bind(binding);
    const byTable = new Map<string, string[]>();
    for (const column of columns) {
      const list = byTable.get(column.table_name) ?? [];
      list.push(column.column_name);
      byTable.set(column.table_name, list);
    }
    let tablesDone = 0;
    for (const [tableName, columnNames] of byTable) {
      const table = `${quoteEventIdentifier(schema)}.${
        quoteEventIdentifier(tableName)
      }`;
      // One scan per table. Only cells that can contain a protected reference or
      // a body identity can change; malformed schema-bearing captures still visit
      // the exact same validator below.
      const selected = (await tx.query<
        {
          tid: string;
          column_name: string;
          value: unknown;
          namespace?: string;
        }
      >(
        `SELECT t.ctid::text AS tid,v.column_name,v.value${
          tableName === "event_bodies" ? ",t.namespace" : ""
        }
         FROM ${table} t CROSS JOIN LATERAL (VALUES ${
          columnNames.map((name) =>
            `(${literal(name)},t.${quoteEventIdentifier(name)}::jsonb)`
          ).join(",")
        }) v(column_name,value)
         WHERE v.value @? '$.**.bodyId' OR v.value @? '$.**.schema'`,
      )).rows;
      const grouped = new Map<string, typeof selected>();
      for (const row of selected) {
        const list = grouped.get(row.column_name) ?? [];
        list.push(row);
        grouped.set(row.column_name, list);
      }
      for (const [column, rows] of grouped) cells.push({ table, column, rows });
      const rows = selected;
      for (const row of rows) {
        visit(row.value, (value) => {
          if (value.schema === PROTECTED_VALUE_REF_SCHEMA) {
            const ref = protectedValueRef(value), old = refs.get(ref.bodyId);
            if (
              old && JSON.stringify(old) !== JSON.stringify(ref)
            ) throw new Error("Conflicting protected references.");
            refs.set(ref.bodyId, ref);
          }
          if (
            row.namespace &&
            value.schema === "copilotz.action.lifecycle.protected.v1"
          ) {
            const data = object(value.data), fields = object(value.protected);
            if (
              !data || !fields || typeof data.actionId !== "string" ||
              typeof data.actionRunId !== "string"
            ) throw new Error("Invalid lifecycle binding.");
            for (const [slot, ref] of Object.entries(fields)) {
              bind({
                namespace: row.namespace,
                ownerId: `${data.actionId}:${data.actionRunId}`,
                slot,
                ref: protectedValueRef(ref),
              });
            }
          }
          if (
            row.namespace &&
            value.schema === "copilotz.event.protected-value.v1" &&
            typeof value.ownerId === "string"
          ) {
            bind({
              namespace: row.namespace,
              ownerId: value.ownerId,
              slot: "data",
              ref: protectedValueRef(value.protected),
            });
          }
        });
      }
      console.error(
        `[upgrade:${schema}] protected reference tables ${++tablesDone}/${byTable.size}`,
      );
    }
    for (const binding of input.bindings ?? []) {
      if (!refs.has(binding.ref.bodyId)) {
        refs.set(binding.ref.bodyId, protectedValueRef(binding.ref));
      }
    }
    const bodies: TransferBody[] = [];
    let bodyCount = 0;
    for await (
      const body of iterateTransferBodies(tx, schema, input.readExternalBody)
    ) {
      bodyCount++;
      if (
        refs.has(body.bodyId) ||
        body.mediaType ===
          "application/vnd.copilotz.action-protected-value+json" ||
        body.backendKind !== "database"
      ) bodies.push(body);
    }
    const bodyById = new Map(bodies.map((body) => [body.bodyId, body]));
    for (const body of bodies) {
      if (
        body.mediaType ===
          "application/vnd.copilotz.action-protected-value+json" &&
        !refs.has(body.bodyId)
      ) {
        throw new Error(
          "Unclassified protected body; supply its original binding and reference.",
        );
      }
    }
    for (const statement of createOwnerDataKeyStatements(schema)) {
      await tx.query(statement);
    }
    const key = await ensureOwnerDataKey(tx, schema, input.masterAdapter),
      cipher = await ownerDataCipher(schema, key, input.masterAdapter);
    const replacements = new Map<string, ProtectedValueRef>();
    for (const [id, ref] of refs) {
      const binding = bindings.get(id),
        body = bodyById.get(id);
      if (
        !binding || !body || body.namespace !== binding.namespace ||
        body.digest !== ref.digest ||
        base64ToBytes(body.bytes).length !== ref.byteLength
      ) {
        throw new Error(
          "Protected value lacks a complete retained binding and body.",
        );
      }
      const aad = additionalAuthenticatedData(schema, binding);
      const plaintext = await input.sourceAdapter.open({
        ciphertext: base64ToBytes(body.bytes),
        envelope: ref.envelope,
        additionalAuthenticatedData: aad,
      });
      try {
        const sealed = await cipher.seal({
          plaintext,
          additionalAuthenticatedData: aad,
        });
        body.bytes = bytesToBase64(sealed.ciphertext);
        body.digest = await digestContent(sealed.ciphertext);
        replacements.set(id, {
          ...ref,
          byteLength: sealed.ciphertext.length,
          digest: body.digest,
          commitment: sealed.commitment,
          envelope: sealed.envelope,
        });
      } finally {
        plaintext.fill(0);
      }
    }
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      const row = object(value);
      if (!row) return value;
      if (row.schema === PROTECTED_VALUE_REF_SCHEMA) {
        return replacements.get(String(row.bodyId)) ?? row;
      }
      const updated = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, rewrite(value)]),
      );
      const ref = replacements.get(String(row.bodyId));
      if (ref && row.mediaType === ref.mediaType) {
        updated.byteLength = ref.byteLength;
        updated.digest = ref.digest;
      }
      return updated;
    };
    // ctid changes on update: combine all changed columns of a row into one UPDATE.
    const updates = new Map<
      string,
      { table: string; tid: string; fields: Record<string, unknown> }
    >();
    for (const cell of cells) {
      for (const row of cell.rows) {
        const value = rewrite(row.value);
        if (JSON.stringify(value) === JSON.stringify(row.value)) continue;
        const id = `${cell.table}:${row.tid}`,
          update = updates.get(id) ??
            { table: cell.table, tid: row.tid, fields: {} };
        update.fields[cell.column] = value;
        updates.set(id, update);
      }
    }
    await tx.query(
      `ALTER TABLE ${tables.events} DISABLE TRIGGER copilotz_events_immutable`,
    );
    const groups = new Map<
      string,
      { table: string; columns: string[]; rows: Record<string, unknown>[] }
    >();
    for (const update of updates.values()) {
      const columns = Object.keys(update.fields).sort();
      const withDigest = update.table === tables.event_bodies &&
        "body" in update.fields;
      const key = JSON.stringify([update.table, columns, withDigest]);
      const group = groups.get(key) ??
        { table: update.table, columns, rows: [] };
      group.rows.push({
        tid: update.tid,
        fields: update.fields,
        ...(withDigest
          ? { digest: (await encodeEventBody(update.fields.body)).digest }
          : {}),
      });
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const sets = group.columns.map((column) =>
        `${quoteEventIdentifier(column)}=v.fields->${literal(column)}`
      );
      if (
        group.table === tables.event_bodies && group.columns.includes("body")
      ) sets.push("digest=v.digest");
      for (let start = 0; start < group.rows.length; start += 2000) {
        await tx.query(
          `UPDATE ${group.table} t SET ${sets.join(",")}
           FROM jsonb_to_recordset($1::jsonb) AS v(tid text,fields jsonb,digest text)
           WHERE t.ctid=v.tid::tid`,
          [JSON.stringify(group.rows.slice(start, start + 2000))],
        );
      }
    }
    await tx.query(
      `ALTER TABLE ${tables.events} ENABLE TRIGGER copilotz_events_immutable`,
    );
    // Plain database copies already belong to this schema. Preserve their
    // physical versions, retention deadlines and historical terminal metadata.
    await installTransferBodies(
      tx,
      schema,
      bodies.filter((body) =>
        replacements.has(body.bodyId) || body.backendKind !== "database"
      ),
    );
    await tx.query(
      `INSERT INTO ${tables.owner_receipts}(owner,domain,key,principal,kind,intent,result) VALUES('schema','logical','owner-keys-upgrade:12','offline-upgrade','owner-keys.upgrade','{}',$1::jsonb)`,
      [JSON.stringify({ protectedValues: refs.size, bodies: bodyCount })],
    );
    await tx.query(
      `UPDATE ${tables.copilotz_schema_metadata} SET version=12 WHERE singleton AND version=11`,
    );
    return { protectedValues: refs.size, bodies: bodyCount };
  });
}
