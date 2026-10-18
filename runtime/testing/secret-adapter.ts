import {
  createSecretAdapter,
  type SecretAdapter,
} from "../actions/secret-adapter.ts";
import { base64ToBytes, bytesToBase64 } from "../content/index.ts";

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export async function testSecretAdapter(): Promise<SecretAdapter> {
  const encryptionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const commitmentKey = await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return createSecretAdapter({
    async seal({ plaintext, additionalAuthenticatedData }) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: buffer(iv),
            additionalData: buffer(additionalAuthenticatedData),
          },
          encryptionKey,
          buffer(plaintext),
        ),
      );
      const committed = new Uint8Array(
        additionalAuthenticatedData.byteLength + plaintext.byteLength,
      );
      committed.set(additionalAuthenticatedData);
      committed.set(plaintext, additionalAuthenticatedData.byteLength);
      const commitment = bytesToBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            commitmentKey,
            buffer(committed),
          ),
        ),
      );
      return Object.freeze({
        ciphertext,
        commitment,
        envelope: Object.freeze({ iv: bytesToBase64(iv), keyVersion: "test" }),
      });
    },
    async open({ ciphertext, additionalAuthenticatedData, envelope }) {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: buffer(base64ToBytes(String(envelope.iv))),
            additionalData: buffer(additionalAuthenticatedData),
          },
          encryptionKey,
          buffer(ciphertext),
        ),
      );
    },
  });
}
