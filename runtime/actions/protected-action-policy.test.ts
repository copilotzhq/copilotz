import { assertEquals, assertThrows } from "@std/assert";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import {
  capturePreparedActionInput,
  validateProtectedActions,
} from "./protected-action-policy.ts";
const action = defineAction({
  id: "fixture.bound",
  ownerHooks: { prepareInput: true },
  inputSchema: {
    type: "object",
    required: ["id", "credential"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      credential: secret({
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      }),
      credentialRevision: { type: ["string", "null"] },
    },
  } as const,
  execute: (input: unknown) => input,
});
const definition = {
  authorize() {},
  prepareInput(input: unknown) {
    return input;
  },
  publicRevisionFields: ["/credentialRevision"],
};
Deno.test("protected preparation permits only declared slots and exact revision fields", () => {
  validateProtectedActions({ [action.id]: definition }, { action });
  const result = capturePreparedActionInput(action, { id: "a" }, {
    id: "a",
    credential: { token: "secret" },
    credentialRevision: "r1",
  }, definition.publicRevisionFields);
  assertEquals(result, {
    id: "a",
    credential: { token: "secret" },
    credentialRevision: "r1",
  });
  assertEquals(Object.isFrozen(result), true);
  assertThrows(
    () =>
      capturePreparedActionInput(action, { id: "a" }, {
        id: "b",
        credential: { token: "secret" },
      }),
    TypeError,
  );
  assertThrows(
    () =>
      capturePreparedActionInput(action, { id: "a" }, {
        id: "a",
        credential: { token: "secret" },
        namespace: "other",
      }),
    TypeError,
  );
  assertThrows(
    () =>
      capturePreparedActionInput(action, { id: "a" }, {
        id: "a",
        credential: { token: 4 },
      }),
    TypeError,
  );
});
Deno.test("protected registrations reject missing phases unknown Actions and overlapping non-scalar revisions", () => {
  assertThrows(
    () => validateProtectedActions(undefined, { action }),
    TypeError,
    "missing",
  );
  assertThrows(
    () =>
      validateProtectedActions({
        [action.id]: { authorize() {}, acceptOutput() {} },
      }, { action }),
    TypeError,
  );
  assertThrows(
    () => validateProtectedActions({ unknown: definition }, { action }),
    TypeError,
  );
  for (
    const fields of [
      ["/credentialRevision", "/credentialRevision"],
      ["/credential"],
      ["/namespace"],
      ["/id"],
      ["/id/x"],
      ["credentialRevision"],
      ["/bad~2path"],
    ]
  ) {
    assertThrows(
      () =>
        validateProtectedActions({
          [action.id]: { ...definition, publicRevisionFields: fields },
        }, { action }),
      TypeError,
    );
  }
  const ordinary = defineAction({
    id: "fixture.ordinary",
    inputSchema: secret({ type: "string" }),
    execute: (input: string) => input,
  });
  assertEquals(validateProtectedActions(undefined, { ordinary }), {});
});
