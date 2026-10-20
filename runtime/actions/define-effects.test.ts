import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction, isActionDefinition } from "./define.ts";
import type { ActionContext, ActionInput, ActionOutput } from "./types.ts";
import { contribution, resolveContributions } from "../plugins/contribution.ts";

interface ProviderContext extends ActionContext {
  readonly resources: {
    readonly provider: { readonly lookup: (step: string) => string };
  };
}

test("declared reconciliation retains Action input/output/context and contribution typing", () => {
  const action = defineAction({
    id: "effect.fixture",
    execute(input: { value: number }, _context: ProviderContext) {
      return { result: input.value };
    },
    reconcile(step, context) {
      const value: string = context.resources.provider.lookup(step);
      return { status: "confirmed", outcome: { reference: value } };
    },
  });
  const input: ActionInput<typeof action> = { value: 1 };
  const output: ActionOutput<typeof action> = { result: 1 };
  assert.deepEqual(action.execute(input, null as never), output);
  assert.ok(isActionDefinition(action));
  const resolved = resolveContributions({
    resources: {
      fixture: {
        declaration: {
          [contribution]: () => ({
            value: "value",
            actions: { effect: action },
          }),
        },
      },
    },
  });
  assert.equal(resolved.actions.effect.reconcile, action.reconcile);
  assert.ok(
    isActionDefinition(
      defineAction({ id: "plain.fixture", execute: () => null }),
    ),
  );
});

test("malformed reconcile declarations are refused without relaxing Action keys", () => {
  const definition = {
    id: "effect.fixture",
    execute: () => null,
    reconcile: "not a hook",
  };
  assert.equal(isActionDefinition(definition), false);
  assert.throws(
    () => defineAction(definition as never),
    /reconcile must be a function/,
  );
  assert.throws(
    () =>
      defineAction({ ...definition, reconcile() {}, ignored: true } as never),
    /cannot declare 'ignored'/,
  );
});
