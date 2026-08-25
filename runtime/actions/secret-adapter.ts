/** Process-local encryption boundary for protected Action values. @module */

import { snapshotEventData } from "../events/types.ts";

export type SecretAdapterSealInput = Readonly<{
  plaintext: Uint8Array;
  additionalAuthenticatedData: Uint8Array;
}>;

export type SecretAdapterOpenInput = Readonly<{
  ciphertext: Uint8Array;
  additionalAuthenticatedData: Uint8Array;
  envelope: Readonly<Record<string, unknown>>;
}>;

export type SecretAdapterSealResult = Readonly<{
  ciphertext: Uint8Array;
  /** Deterministic keyed commitment. It must reveal nothing about plaintext. */
  commitment: string;
  /** Secret-free key/version/nonce metadata needed by `open`. */
  envelope: Readonly<Record<string, unknown>>;
}>;

export type SecretAdapter = Readonly<{
  seal(
    input: SecretAdapterSealInput,
  ): SecretAdapterSealResult | Promise<SecretAdapterSealResult>;
  open(input: SecretAdapterOpenInput): Uint8Array | Promise<Uint8Array>;
}>;

function dataMethod(
  value: object,
  key: "seal" | "open",
): (...args: never[]) => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    !descriptor?.enumerable || !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError(
      `Secret Adapter ${key} must be an enumerable function.`,
    );
  }
  return descriptor.value as (...args: never[]) => unknown;
}

/** Validates and freezes one application-owned Secret Adapter. */
export function createSecretAdapter<const TAdapter extends SecretAdapter>(
  adapter: TAdapter,
): TAdapter {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TypeError("Secret Adapter must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(adapter);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Secret Adapter must be a plain object.");
  }
  const keys = Reflect.ownKeys(adapter);
  if (
    keys.length !== 2 || keys.some((key) => key !== "seal" && key !== "open")
  ) {
    throw new TypeError("Secret Adapter accepts exactly seal and open.");
  }
  const seal = dataMethod(adapter, "seal") as SecretAdapter["seal"];
  const open = dataMethod(adapter, "open") as SecretAdapter["open"];
  return Object.freeze({ seal, open }) as TAdapter;
}

export function secretEnvelope(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "Secret Adapter envelope must be a strict JSON object.",
    );
  }
  return snapshotEventData(
    value as Readonly<Record<string, unknown>>,
    "Secret Adapter envelope",
  );
}
