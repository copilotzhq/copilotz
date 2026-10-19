/** Owner-local envelope encryption. Only wrapped key material is durable. */
import { base64ToBytes, bytesToBase64 } from "../content/encoding.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  createSecretAdapter,
  type SecretAdapter,
  secretEnvelope,
} from "./secret-adapter.ts";

export type WrappedOwnerDataKey = {
  key_id: string;
  wrapped_key: string;
  envelope: Readonly<Record<string, unknown>>;
};
const FORMAT = "copilotz.owner-data-key.v1";
const bytes = (value: Uint8Array) => value.slice().buffer as ArrayBuffer;
function wrappingAAD(schema: string, id: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ format: FORMAT, databaseSchema: schema, keyId: id }),
  );
}
export async function wrapOwnerDataKey(
  schema: string,
  keyId: string,
  material: Uint8Array,
  master: SecretAdapter,
): Promise<WrappedOwnerDataKey> {
  if (material.length !== 64) throw new Error("Invalid owner data key.");
  const sealed = await master.seal({
    plaintext: material.slice(),
    additionalAuthenticatedData: wrappingAAD(schema, keyId),
  });
  return {
    key_id: keyId,
    wrapped_key: bytesToBase64(sealed.ciphertext),
    envelope: secretEnvelope(sealed.envelope),
  };
}
export async function unwrapOwnerDataKey(
  schema: string,
  row: WrappedOwnerDataKey,
  master: SecretAdapter,
): Promise<Uint8Array> {
  const material = await master.open({
    ciphertext: base64ToBytes(row.wrapped_key),
    envelope: row.envelope,
    additionalAuthenticatedData: wrappingAAD(schema, row.key_id),
  });
  if (!(material instanceof Uint8Array) || material.length !== 64) {
    throw new Error("Invalid owner data key.");
  }
  return material;
}
/** Re-wrap without changing ciphertexts, their commitments, or any references. */
export async function rewrapOwnerDataKey(
  schema: string,
  row: WrappedOwnerDataKey,
  source: SecretAdapter,
  destination: SecretAdapter,
): Promise<WrappedOwnerDataKey> {
  const material = await unwrapOwnerDataKey(schema, row, source);
  try {
    return await wrapOwnerDataKey(schema, row.key_id, material, destination);
  } finally {
    material.fill(0);
  }
}
export async function readOwnerDataKey(
  executor: SqlExecutor,
  schema: string,
): Promise<WrappedOwnerDataKey | undefined> {
  return (await executor.query<WrappedOwnerDataKey>(
    `SELECT key_id,wrapped_key,envelope FROM ${
      createCoreTableNames(schema).owner_data_keys
    } WHERE singleton=TRUE`,
  )).rows[0];
}
/** Caller serializes this insertion in the owner's command or offline transaction. */
export async function ensureOwnerDataKey(
  executor: SqlExecutor,
  schema: string,
  master: SecretAdapter,
): Promise<WrappedOwnerDataKey> {
  const existing = await readOwnerDataKey(executor, schema);
  if (existing) return existing;
  const material = crypto.getRandomValues(new Uint8Array(64));
  let row: WrappedOwnerDataKey;
  try {
    row = await wrapOwnerDataKey(schema, crypto.randomUUID(), material, master);
  } finally {
    material.fill(0);
  }
  await executor.query(
    `INSERT INTO ${
      createCoreTableNames(schema).owner_data_keys
    }(singleton,key_id,wrapped_key,envelope) VALUES(TRUE,$1,$2,$3::jsonb)`,
    [row.key_id, row.wrapped_key, JSON.stringify(row.envelope)],
  );
  return row;
}
export async function ownerDataCipher(
  schema: string,
  row: WrappedOwnerDataKey,
  master: SecretAdapter,
): Promise<SecretAdapter> {
  const material = await unwrapOwnerDataKey(schema, row, master);
  let encryption: CryptoKey, commitmentKey: CryptoKey;
  try {
    encryption = await crypto.subtle.importKey(
      "raw",
      bytes(material.subarray(0, 32)),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    commitmentKey = await crypto.subtle.importKey(
      "raw",
      bytes(material.subarray(32)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } finally {
    material.fill(0);
  }
  return createSecretAdapter({
    async seal({ plaintext, additionalAuthenticatedData }) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: bytes(iv),
            additionalData: bytes(additionalAuthenticatedData),
          },
          encryption,
          bytes(plaintext),
        ),
      );
      const committed = new Uint8Array(
        4 + additionalAuthenticatedData.length + plaintext.length,
      );
      new DataView(committed.buffer).setUint32(
        0,
        additionalAuthenticatedData.length,
      );
      committed.set(additionalAuthenticatedData, 4);
      committed.set(plaintext, 4 + additionalAuthenticatedData.length);
      const commitment = bytesToBase64(
        new Uint8Array(
          await crypto.subtle.sign("HMAC", commitmentKey, bytes(committed)),
        ),
      );
      return {
        ciphertext,
        commitment,
        envelope: { format: FORMAT, keyId: row.key_id, iv: bytesToBase64(iv) },
      };
    },
    async open({ ciphertext, additionalAuthenticatedData, envelope }) {
      if (
        envelope.format !== FORMAT || envelope.keyId !== row.key_id ||
        typeof envelope.iv !== "string" ||
        Object.keys(envelope).sort().join(",") !== "format,iv,keyId"
      ) throw new Error("Invalid owner data envelope.");
      const iv = base64ToBytes(envelope.iv);
      if (iv.length !== 12) throw new Error("Invalid owner data nonce.");
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bytes(iv),
            additionalData: bytes(additionalAuthenticatedData),
          },
          encryption,
          bytes(ciphertext),
        ),
      );
    },
  });
}
