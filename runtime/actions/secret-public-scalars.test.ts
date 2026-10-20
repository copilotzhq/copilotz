import { assertEquals, assertThrows } from "@std/assert";
import { defineAction } from "./define.ts";
import {
  assertMetadataIsSecretFree,
  protectedActionStrings,
  secret,
  splitSecretActionValue,
} from "./secret.ts";

const publicString = {
  type: ["string", "null"],
  "x-copilotz-secret": false,
} as const;
const schema = {
  type: "object",
  properties: {
    credential: secret({
      type: ["object", "null"],
      properties: {
        ownerId: publicString,
        kind: publicString,
        nested: {
          type: "object",
          properties: { "scope/~": publicString, token: { type: "string" } },
        },
        token: { type: "string" },
      },
    }),
  },
} as const;
const input = {
  credential: {
    ownerId: "public",
    kind: "start",
    nested: { "scope/~": "public", token: "nested-secret" },
    token: "actual-token",
  },
};

Deno.test("public scalar annotations leave aggregate storage sealed and permit exact public coordinates", () => {
  assertEquals(splitSecretActionValue(schema, input), {
    secret: true,
    publicValue: { credential: { "$copilotz-secret": true } },
  });
  assertEquals(protectedActionStrings(schema, input), [
    "nested-secret",
    "actual-token",
  ]);
  assertMetadataIsSecretFree({
    namespace: "public",
    route: "fixture.google-start",
  }, protectedActionStrings(schema, input));
});
Deno.test("public scalar annotations never whitelist equal token bytes or undeclared nested leaves", () => {
  for (const value of ["actual-token", "nested-secret"]) {
    assertThrows(
      () =>
        assertMetadataIsSecretFree(
          { value },
          protectedActionStrings(schema, input),
        ),
      TypeError,
    );
  }
  assertThrows(
    () =>
      assertMetadataIsSecretFree(
        { namespace: "public" },
        protectedActionStrings(schema, {
          credential: { ...input.credential, token: "public" },
        }),
      ),
    TypeError,
  );
  assertThrows(
    () =>
      assertMetadataIsSecretFree(
        { value: "prefix-hidden-field-suffix" },
        protectedActionStrings(schema, {
          credential: { ...input.credential, unknown: "hidden-field" },
        }),
      ),
    TypeError,
  );
  assertEquals(protectedActionStrings(schema, { credential: null }), []);
});
Deno.test("public scalar annotations refuse parent, array, missing type, refs and ambiguous paths", () => {
  for (
    const field of [
      { type: "object" },
      { type: "array", items: { type: "string" } },
      {},
      { type: ["string", "object"] },
      { type: "string", $ref: "#/$defs/text" },
      { type: "string", oneOf: [{ const: "public" }] },
    ] as const
  ) {
    assertThrows(
      () =>
        secret({
          type: "object",
          $defs: { text: { type: "string" } },
          properties: { field: { ...field, "x-copilotz-secret": false } },
        }),
      TypeError,
    );
  }
  for (
    const container of [
      {
        type: "object",
        anyOf: [{ type: "object" }],
        properties: { value: publicString },
      },
      {
        type: "object",
        patternProperties: { ".*": { type: "string" } },
        properties: { value: publicString },
      },
      { type: "array", items: publicString },
      {
        type: "object",
        $defs: { text: publicString },
        properties: { value: { $ref: "#/$defs/text" } },
      },
    ] as const
  ) assertThrows(() => secret(container), TypeError);
  const reusable = {
    type: "object",
    properties: { value: publicString },
  } as const;
  defineAction({
    id: "fixture.public-schema",
    inputSchema: reusable,
    execute: () => true,
  });
  assertEquals(protectedActionStrings(reusable, { value: "public" }), []);
});

Deno.test("public scalar annotations traverse homogeneous object arrays without wildcard key exemptions", () => {
  const schema = secret(
    {
      type: "object",
      properties: {
        tenants: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: publicString,
              "scope/~": publicString,
              token: { type: "string" },
            },
          },
        },
        "*": { type: "object", properties: { id: { type: "string" } } },
      },
    } as const,
  );
  const value = {
    tenants: [{ id: "public", "scope/~": "public", token: "secret-a" }, {
      id: "other",
      "scope/~": null,
      token: "secret-b",
    }],
    "*": { id: "literal-key-secret" },
  };
  assertEquals(protectedActionStrings(schema, value), [
    "literal-key-secret",
    "secret-a",
    "secret-b",
  ]);
  assertEquals(splitSecretActionValue(schema, value).publicValue, {
    "$copilotz-secret": true,
  });
  assertEquals(
    protectedActionStrings(schema, {
      ...value,
      tenants: [{ id: "public", token: "public" }],
    }),
    ["literal-key-secret", "public"],
  );
  for (
    const items of [
      { type: "string", "x-copilotz-secret": false },
      {
        type: "object",
        "x-copilotz-secret": false,
        properties: { id: publicString },
      },
      {
        type: "object",
        oneOf: [{ type: "object" }],
        properties: { id: publicString },
      },
    ] as const
  ) assertThrows(() => secret({ type: "array", items }), TypeError);
  assertThrows(
    () =>
      secret({
        type: "array",
        prefixItems: [{ type: "object", properties: { id: publicString } }],
      }),
    TypeError,
  );
  assertThrows(
    () =>
      secret({
        type: "array",
        contains: { type: "string" },
        items: { type: "object", properties: { id: publicString } },
      }),
    TypeError,
  );
});
