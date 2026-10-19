const test = Deno.test;
import assert from "node:assert/strict";
import { actionPreparationIntent } from "./preparation-intent.ts";

const facts = () => ({
  preparation: "channelText",
  operationKey: "reply",
  parentOperationKey: "parent",
  source: "messages",
  recordId: "message-1",
  actionId: "fixture.send",
  hints: { mode: "channel", renderer: "text" as const },
});
test("preparation semantic intent preserves the existing pinned command digest", async () => {
  assert.deepEqual(await actionPreparationIntent(facts()), {
    encoding: "copilotz.preparation.v1",
    digest:
      "sha256:95398fa5240dc9dc7e9eaf8a5a46db15c60481e8511645c44f48fbb8a14dbc1c",
  });
  const first = await actionPreparationIntent(facts());
  for (
    const key of [
      "preparation",
      "operationKey",
      "parentOperationKey",
      "source",
      "recordId",
      "actionId",
    ] as const
  ) {
    assert.notDeepEqual(
      await actionPreparationIntent({ ...facts(), [key]: "other" }),
      first,
    );
  }
  assert.notDeepEqual(
    await actionPreparationIntent({
      ...facts(),
      hints: { mode: "other", renderer: "text" },
    }),
    first,
  );
});
test("preparation intent snapshots before digest and never invokes accessors", async () => {
  const original = facts();
  const pending = actionPreparationIntent(original);
  original.recordId = "changed";
  original.hints.mode = "changed";
  assert.deepEqual(await pending, await actionPreparationIntent(facts()));
  let invoked = 0;
  const accessor = {
    ...facts(),
    get recordId() {
      invoked++;
      return "record";
    },
  };
  await assert.rejects(actionPreparationIntent(accessor));
  assert.equal(invoked, 0);
  for (const extra of ["assignmentId", "namespace", "viewHash", "rendered"]) {
    await assert.rejects(
      actionPreparationIntent({ ...facts(), [extra]: "unsupported" }),
    );
  }
});
