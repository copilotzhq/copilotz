import { assert, assertEquals, assertThrows } from "@std/assert";
import { defineAction } from "./define.ts";
import { secret } from "./index.ts";
import {
  actionSchemaHasSecrets,
  rehydrateSecretActionValue,
  splitSecretActionValue,
} from "./secret.ts";

const redacted = { "$copilotz-secret": true } as const;

Deno.test("secret marks and freezes the exact schema snapshot", () => {
  const marked = secret({ type: "string", minLength: 1 } as const);
  const raw = {
    type: "string",
    minLength: 1,
    "x-copilotz-secret": true,
  } as const;

  assert(Object.isFrozen(marked));
  assertEquals(actionSchemaHasSecrets(marked), true);
  assertEquals(
    splitSecretActionValue(marked, "helper plaintext"),
    splitSecretActionValue(raw, "raw plaintext"),
  );
  assertEquals(splitSecretActionValue(marked, "helper plaintext"), {
    publicValue: redacted,
    secret: true,
  });
});

Deno.test("secret traversal redacts nested objects, arrays, and unions without plaintext", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      credentials: {
        type: "object",
        properties: {
          password: { type: "string", "x-copilotz-secret": true },
        },
      },
      tokens: {
        type: "array",
        items: { type: "string", "x-copilotz-secret": true },
      },
      choice: {
        oneOf: [
          {
            type: "object",
            properties: { pin: { "x-copilotz-secret": true } },
          },
          { type: "object", properties: { label: { type: "string" } } },
        ],
      },
    },
  } as const;
  const value = {
    credentials: { password: "object plaintext" },
    tokens: ["array plaintext one", "array plaintext two"],
    choice: { pin: "union plaintext" },
  };

  const split = splitSecretActionValue(schema, value);
  assertEquals(split.secret, true);
  assertEquals(split.publicValue, {
    credentials: { password: redacted },
    tokens: [redacted, redacted],
    choice: { pin: redacted },
  });
  for (
    const plaintext of [
      "object plaintext",
      "array plaintext one",
      "array plaintext two",
      "union plaintext",
    ]
  ) assertEquals(JSON.stringify(split.publicValue).includes(plaintext), false);
});

Deno.test("secret traversal follows local refs and rehydrates only matching public structure", () => {
  const schema = {
    type: "object",
    $defs: {
      credential: {
        type: "object",
        properties: { token: { type: "string", "x-copilotz-secret": true } },
      },
    },
    properties: {
      credentials: { type: "array", items: { $ref: "#/$defs/credential" } },
      account: { type: "string" },
    },
  } as const;
  const plaintext = {
    account: "unchanged public account",
    credentials: [{ token: "first ref plaintext" }, {
      token: "second ref plaintext",
    }],
  };
  const split = splitSecretActionValue(schema, plaintext);

  assertEquals(split.publicValue, {
    account: "unchanged public account",
    credentials: [{ token: redacted }, { token: redacted }],
  });
  assertEquals(
    rehydrateSecretActionValue(schema, split.publicValue, plaintext),
    plaintext,
  );
  assertThrows(
    () =>
      rehydrateSecretActionValue(schema, split.publicValue, {
        ...plaintext,
        account: "tampered public account",
      }),
    TypeError,
    "does not match the durable public value",
  );
});

Deno.test("only boolean true marks a secret", () => {
  const falseMarker = {
    type: "object",
    properties: {
      value: {
        "x-copilotz-secret": false,
      },
    },
  } as const;
  const stringMarker = {
    type: "object",
    properties: {
      value: {
        "x-copilotz-secret": "true",
      },
    },
  } as const;

  for (const schema of [falseMarker, stringMarker]) {
    assertEquals(actionSchemaHasSecrets(schema as never), false);
    assertEquals(
      splitSecretActionValue(schema as never, { value: "not secret" }),
      {
        publicValue: { value: "not secret" },
        secret: false,
      },
    );
  }
});

Deno.test("defineAction snapshots and freezes schemas while rejecting unsafe refs", () => {
  const source = {
    type: "object",
    properties: { apiKey: { type: "string", "x-copilotz-secret": true } },
  } as const;
  const action = defineAction({
    id: "secret.schema",
    inputSchema: source,
    execute: () => null,
  });

  assertEquals(action.inputSchema, source);
  assert(Object.isFrozen(action.inputSchema));
  assert(Object.isFrozen(action.inputSchema!.properties));
  assertThrows(
    () =>
      defineAction({
        id: "secret.external-ref",
        inputSchema: { $ref: "https://schemas.example/credential" },
        execute: () => null,
      }),
    TypeError,
    "not a local JSON Pointer",
  );
  assertThrows(
    () =>
      defineAction({
        id: "secret.ref-cycle",
        inputSchema: { $defs: { self: { $ref: "#/$defs/self" } } },
        execute: () => null,
      }),
    TypeError,
    "is cyclic",
  );

  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.properties = { value: cyclic };
  assertThrows(
    () =>
      defineAction({
        id: "secret.cyclic",
        inputSchema: cyclic as never,
        execute: () => null,
      }),
    TypeError,
    "schema object graph is cyclic",
  );
});
