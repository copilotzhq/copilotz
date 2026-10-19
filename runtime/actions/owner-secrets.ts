/** Application-owned values sealed under an owner's data key. @module */
import { base64ToBytes, bytesToBase64 } from "../content/encoding.ts";
import { canonicalJson } from "../data-only-json.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { validateEventSchemaName } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  ensureOwnerDataKey,
  ownerDataCipher,
  readOwnerDataKey,
} from "./owner-data-key.ts";
import type { SecretAdapter } from "./secret-adapter.ts";

/**
 * Application context bound to a sealed value, such as a record id and field.
 * A value opens only under the same schema and binding it was sealed with.
 */
export type OwnerSecretBinding = Readonly<Record<string, string>>;

export type OwnerSecrets = Readonly<{
  seal(
    databaseSchema: string,
    plaintext: string,
    binding: OwnerSecretBinding,
  ): Promise<string>;
  open(
    databaseSchema: string,
    sealed: string,
    binding: OwnerSecretBinding,
  ): Promise<string>;
}>;

const FORMAT = "copilotz.owner-secret.v1";
const KEY_FORMAT = "copilotz.owner-data-key.v1";

function aad(databaseSchema: string, binding: OwnerSecretBinding) {
  const entries = Object.entries(binding);
  if (
    !entries.length ||
    entries.some(([, value]) => typeof value !== "string" || !value)
  ) throw new Error("Owner secret binding requires nonempty string values.");
  return new TextEncoder().encode(
    canonicalJson({ format: FORMAT, databaseSchema, binding }),
  );
}

/**
 * Seal and open application values, for example connected-account tokens,
 * under the schema owner's data key. Values move with the owner: export
 * re-wraps the key and leaves every sealed value unchanged. Sealing provisions
 * a missing key through an owner command; opening never creates one.
 */
export function createOwnerSecrets(options: {
  session: SqlExecutor;
  master: SecretAdapter;
}): OwnerSecrets {
  const cipher = async (databaseSchema: string, create: boolean) => {
    const schema = validateEventSchemaName(databaseSchema);
    const key = await readOwnerDataKey(options.session, schema) ??
      (create
        ? await createSchemaCommandRunner(options.session, schema)(
          "owner-secrets.key",
          {},
          (_input, command) =>
            ensureOwnerDataKey(command.transaction, schema, options.master),
        )
        : undefined);
    if (!key) {
      throw Object.assign(new Error("Owner data key is not provisioned."), {
        code: "copilotz_owner_data_key_missing",
      });
    }
    return await ownerDataCipher(schema, key, options.master);
  };
  return {
    async seal(databaseSchema, plaintext, binding) {
      const additionalAuthenticatedData = aad(databaseSchema, binding);
      const sealed = await (await cipher(databaseSchema, true)).seal({
        plaintext: new TextEncoder().encode(plaintext),
        additionalAuthenticatedData,
      });
      return JSON.stringify({
        format: FORMAT,
        keyId: sealed.envelope.keyId,
        iv: sealed.envelope.iv,
        ciphertext: bytesToBase64(sealed.ciphertext),
      });
    },
    async open(databaseSchema, value, binding) {
      const additionalAuthenticatedData = aad(databaseSchema, binding);
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (
        parsed.format !== FORMAT || typeof parsed.keyId !== "string" ||
        typeof parsed.iv !== "string" ||
        typeof parsed.ciphertext !== "string" ||
        Object.keys(parsed).sort().join(",") !== "ciphertext,format,iv,keyId"
      ) throw new Error("Invalid owner secret.");
      const plaintext = await (await cipher(databaseSchema, false)).open({
        ciphertext: base64ToBytes(parsed.ciphertext),
        envelope: { format: KEY_FORMAT, keyId: parsed.keyId, iv: parsed.iv },
        additionalAuthenticatedData,
      });
      return new TextDecoder().decode(plaintext);
    },
  };
}
