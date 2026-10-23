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
    async function* cells() {
      for (const [tableName, columnNames] of byTable) {
        const table = `${quoteEventIdentifier(schema)}.${
          quoteEventIdentifier(tableName)
        }`;
        // Snapshot only tuple identities before updates can move tuples.
        const keys: string[] = [];
        const cursor = quoteEventIdentifier(
          `offline_key_tids_${crypto.randomUUID().replaceAll("-", "")}`,
        );
        await tx.query(
          `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ctid::text AS tid FROM ${table}`,
        );
        try {
          while (true) {
            const batch = (await tx.query<{ tid: string }>(
              `FETCH FORWARD 2000 FROM ${cursor}`,
            )).rows;
            keys.push(...batch.map((row) => row.tid));
            if (batch.length < 2000) break;
          }
        } finally {
          await tx.query(`CLOSE ${cursor}`);
        }
        for (let start = 0; start < keys.length; start += 1000) {
          const rows = (await tx.query<
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
             WHERE t.ctid=ANY($1::tid[]) AND (v.value @? '$.**.bodyId' OR v.value @? '$.**.schema')`,
            [keys.slice(start, start + 1000)],
          )).rows;
          yield { table, rows };
        }
      }
    }
    for await (const { rows } of cells()) {
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
    }
    for (const binding of input.bindings ?? []) {
      if (!refs.has(binding.ref.bodyId)) {
        refs.set(binding.ref.bodyId, protectedValueRef(binding.ref));
      }
    }
    for (const statement of createOwnerDataKeyStatements(schema)) {
      await tx.query(statement);
    }
    const key = await ensureOwnerDataKey(tx, schema, input.masterAdapter),
      cipher = await ownerDataCipher(schema, key, input.masterAdapter);
    const replacements = new Map<string, ProtectedValueRef>();
    const pendingBodies: TransferBody[] = [];
    let pendingBytes = 0;
    async function flushBodies() {
      if (!pendingBodies.length) return;
      await installTransferBodies(tx, schema, pendingBodies);
      pendingBodies.length = 0;
      pendingBytes = 0;
    }
    async function stageBody(body: TransferBody) {
      if (pendingBytes + body.bytes.length > 16 * 1024 * 1024) {
        await flushBodies();
      }
      pendingBodies.push(body);
      pendingBytes += body.bytes.length;
      if (pendingBodies.length >= 1000) await flushBodies();
    }
    let bodyCount = 0;
    const seen = new Set<string>();
    for await (
      const body of iterateTransferBodies(tx, schema, input.readExternalBody)
    ) {
      bodyCount++;
      const id = body.bodyId, ref = refs.get(id);
      if (!ref) {
        if (
          body.mediaType ===
            "application/vnd.copilotz.action-protected-value+json"
        ) {
          throw new Error(
            "Unclassified protected body; supply its original binding and reference.",
          );
        }
        if (body.backendKind !== "database") await stageBody(body);
        continue;
      }
      const binding = bindings.get(id);
      if (
        !binding || body.namespace !== binding.namespace ||
        body.digest !== ref.digest ||
        base64ToBytes(body.bytes).length !== ref.byteLength
      ) {
        throw new Error(
          "Protected value lacks a complete retained binding and body.",
        );
      }
      seen.add(id);
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
      await stageBody(body);
    }
    await flushBodies();
    if (seen.size !== refs.size) {
      throw new Error(
        "Protected value lacks a complete retained binding and body.",
      );
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
    await tx.query(
      `ALTER TABLE ${tables.events} DISABLE TRIGGER copilotz_events_immutable`,
    );
    for await (const { table, rows } of cells()) {
      const updates = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const value = rewrite(row.value);
        if (JSON.stringify(value) === JSON.stringify(row.value)) continue;
        const fields = updates.get(row.tid) ?? {};
        fields[row.column_name] = value;
        updates.set(row.tid, fields);
      }
      const groups = new Map<
        string,
        { columns: string[]; rows: Record<string, unknown>[] }
      >();
      for (const [tid, fields] of updates) {
        const columns = Object.keys(fields).sort(),
          key = JSON.stringify(columns);
        const group = groups.get(key) ?? { columns, rows: [] };
        group.rows.push({
          tid,
          fields,
          ...(table === tables.event_bodies && "body" in fields
            ? { digest: (await encodeEventBody(fields.body)).digest }
            : {}),
        });
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const sets = group.columns.map((column) =>
          `${quoteEventIdentifier(column)}=v.fields->${literal(column)}`
        );
        if (table === tables.event_bodies && group.columns.includes("body")) {
          sets.push("digest=v.digest");
        }
        await tx.query(
          `UPDATE ${table} t SET ${
            sets.join(",")
          } FROM jsonb_to_recordset($1::jsonb) AS v(tid text,fields jsonb,digest text) WHERE t.ctid=v.tid::tid`,
          [JSON.stringify(group.rows)],
        );
      }
    }
    await tx.query(
      `ALTER TABLE ${tables.events} ENABLE TRIGGER copilotz_events_immutable`,
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
