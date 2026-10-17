import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import { ownerEffectKey } from "./effects-client.ts";

const scope = {
  ownerId: "owner",
  schema: "public",
  namespace: "space_%\\雪",
  actionRunId: "run",
};
async function fixture() {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  await db.query(
    "INSERT INTO owner_epochs(owner,epoch,holder) VALUES('owner',1,'holder')",
  );
  async function insert(
    step: string,
    operation: "begin" | "confirm" | "notStarted",
    outcome: unknown = null,
  ) {
    const ref = {
      namespace: scope.namespace,
      actionRunId: scope.actionRunId,
      step,
    };
    const extra = operation === "confirm"
      ? { outcome }
      : operation === "notStarted"
      ? { evidence: { source: "dispatch", reference: "verified" } }
      : {};
    await db.query(
      "INSERT INTO owner_receipts(owner,worker_id,domain,key,kind,intent,result) VALUES('owner','worker','logical',$1,$2,$3::jsonb,$4::jsonb)",
      [
        ownerEffectKey("owner", ref, operation),
        `effect.${operation}`,
        JSON.stringify({ ...ref, ...extra }),
        JSON.stringify({
          ...ref,
          status: operation === "begin"
            ? "begun"
            : operation === "confirm"
            ? "confirmed"
            : "not_started",
          ...(operation === "confirm" ? { outcome } : {}),
        }),
      ],
    );
  }
  return {
    db,
    insert,
    read: () => readOwnerEffectInventory(db, scope),
    close: () => db.close(),
  };
}

test("bounded effect inventory returns complete safe state references with exact wildcard/unicode scope", async () => {
  const f = await fixture();
  try {
    await f.insert("begun", "begin");
    await f.insert("confirmed", "begin");
    await f.insert("confirmed", "confirm", {
      neverHydrate: "OUTCOME_MUST_NOT_BE_RETURNED",
    });
    await f.insert("closed", "begin");
    await f.insert("closed", "notStarted");
    await f.insert("null", "begin");
    await f.insert("null", "confirm", null);
    assert.deepEqual(await f.read(), [
      { step: "begun", status: "begun" },
      { step: "closed", status: "not_started" },
      { step: "confirmed", status: "confirmed" },
      { step: "null", status: "confirmed" },
    ]);
    assert.deepEqual(
      await readOwnerEffectInventory(f.db, {
        ...scope,
        namespace: "space_other雪",
      }),
      [],
    );
    assert.deepEqual(
      await readOwnerEffectInventory(f.db, {
        ...scope,
        actionRunId: "run-other",
      }),
      [],
    );
  } finally {
    await f.close();
  }
});

test("inventory refuses malformed identity, transition and missing/mismatched outcomes", async () => {
  const f = await fixture();
  try {
    const corruptions = [
      "UPDATE owner_receipts SET kind='effect.unknown' WHERE kind='effect.confirm'",
      "UPDATE owner_receipts SET domain='occurrence' WHERE kind='effect.confirm'",
      "UPDATE owner_receipts SET result=result-'outcome' WHERE kind='effect.confirm'",
      "UPDATE owner_receipts SET intent=intent-'outcome' WHERE kind='effect.confirm'",
      `UPDATE owner_receipts SET result=jsonb_set(result,'{outcome}','"different"') WHERE kind='effect.confirm'`,
      `UPDATE owner_receipts SET result=jsonb_set(result,'{step}','"wrong"') WHERE kind='effect.confirm'`,
      "DELETE FROM owner_receipts WHERE kind='effect.begin'",
    ];
    for (const sql of corruptions) {
      await f.db.query("DELETE FROM owner_receipts");
      await f.insert("send", "begin");
      await f.insert("send", "confirm", null);
      await f.db.query(sql);
      await assert.rejects(f.read(), {
        code: sql.includes("{step}")
          ? "effect_binding_invalid"
          : "effect_state_invalid",
      });
    }
    await f.db.query("DELETE FROM owner_receipts");
    await f.insert("send", "begin");
    await f.insert("send", "confirm", null);
    await f.insert("send", "notStarted");
    await assert.rejects(f.read(), { code: "effect_state_invalid" });
  } finally {
    await f.close();
  }
});

test("inventory fails oversized runs rather than truncating their unresolved effects", async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 101; index++) {
      await f.insert(`step-${index}`, "begin");
    }
    await assert.rejects(f.read(), { code: "effect_step_limit" });
  } finally {
    await f.close();
  }
});
