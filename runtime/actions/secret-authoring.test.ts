import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "./define.ts";
import { actionDefinitionHasSecrets as legacyPredicate } from "./protected-lifecycle.ts";
import { actionDefinitionHasSecrets, secret } from "./secret.ts";

test("protected lifecycle preserves the exact pure authoring predicate", () => {
  assert.equal(legacyPredicate, actionDefinitionHasSecrets);
  const plain = defineAction({ id: "plain", execute: () => "plain" });
  assert.equal(actionDefinitionHasSecrets(plain), false);
  for (const field of ["inputSchema", "outputSchema"] as const) {
    const action = defineAction({
      id: `secret.${field}`,
      [field]: {
        type: "object",
        properties: { token: secret({ type: "string" }) },
      } as const,
      execute: () => "ordinary",
    });
    assert.equal(actionDefinitionHasSecrets(action), true);
    assert.equal(legacyPredicate(action), true);
  }
});

test("pure Action authoring retains secret and content incompatibility", () => {
  for (const field of ["inputSchema", "outputSchema"] as const) {
    assert.throws(() =>
      defineAction({
        id: `secret.content.${field}`,
        content: { input: ["files"] },
        [field]: secret({ type: "string" }),
        execute: () => "ordinary",
      }), /content cannot yet be combined with secret schemas/);
  }
});
