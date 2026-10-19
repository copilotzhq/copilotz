import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import { createOwnerCommands } from "../engine/commands.ts";
import {
  createOwnerEffectClient,
  readActionEffectInventory,
} from "./effect-commands.ts";
import { EFFECT_STEP_LIMIT, effectKey } from "./effect-client.ts";

for (
  const url of [
    ":memory:",
    ...(Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")
      ? [Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")!]
      : []),
  ]
) {
  const backend = url === ":memory:" ? "embedded" : "PostgreSQL";
  Deno.test(`${backend}: effects grant once, replay confirmed outcomes and reject illegal transitions`, async () => {
    const db = await createTestDatabase({ url });
    const schema = `effects_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await provisionCopilotzSchema(db, schema);
      const client = createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "run",
      });
      assertEquals(await client.inspect("send"), { status: "none" });
      await assertRejects(
        () => client.confirm("send", null),
        Error,
        "Only a begun",
      );
      assertEquals(
        await Promise.all([client.begin("send"), client.begin("send")]),
        [{ status: "proceed" }, { status: "indeterminate" }],
      );
      await assertRejects(
        () =>
          client.notStarted("send", {
            source: "worker",
            reference: "unverified",
          }),
        Error,
        "No owner-verified",
      );
      await client.confirm("send", { provider: "123" });
      await client.confirm("send", { provider: "123" });
      assertEquals(await client.begin("send"), {
        status: "replay",
        outcome: { provider: "123" },
      });
      await assertRejects(
        () => client.confirm("send", { provider: "456" }),
        Error,
        "Only a begun",
      );
      assertEquals(await client.inventory(), [{
        step: "send",
        status: "confirmed",
      }]);
      const stored = await db.query<{ result: unknown }>(
        `SELECT result FROM ${
          createCoreTableNames(schema).owner_receipts
        } WHERE key=$1`,
        [effectKey(
          { namespace: "space", actionRunId: "run", step: "send" },
          "begin",
        )],
      );
      assertEquals(stored.rows[0].result, {
        namespace: "space",
        actionRunId: "run",
        step: "send",
        status: "begun",
      });
    } finally {
      await db.close();
    }
  });
  Deno.test(`${backend}: verified not-started closes a step and only a new step can dispatch`, async () => {
    const db = await createTestDatabase({ url });
    const schema = `effects_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await provisionCopilotzSchema(db, schema);
      const client = createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "run",
        verifyNotStarted: (_tx, ref, evidence) =>
          ref.step === "send:1" && evidence.source === "dispatch" &&
          evidence.reference === "not-accepted",
      });
      const proof = { source: "dispatch", reference: "not-accepted" };
      await client.begin("send:1");
      await client.notStarted("send:1", proof);
      await client.notStarted("send:1", proof);
      assertEquals(await client.begin("send:1"), { status: "not_started" });
      await assertRejects(
        () => client.confirm("send:1", null),
        Error,
        "Only a begun",
      );
      assertEquals(await client.begin("send:2"), { status: "proceed" });
      await client.confirm("send:2", null);
      assertEquals(await client.begin("send:2"), {
        status: "replay",
        outcome: null,
      });
    } finally {
      await db.close();
    }
  });
  Deno.test(`${backend}: takeover fences stale effect settlement and never reissues a dispatch permit`, async () => {
    const db = await createTestDatabase({ url });
    const schema = `effects_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await provisionCopilotzSchema(db, schema);
      const client = createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "run",
      });
      await client.begin("send");
      const epoch = Number(
        (await db.query<{ epoch: number }>(
          `SELECT epoch FROM ${createCoreTableNames(schema).owner_epochs}`,
        )).rows[0].epoch,
      );
      const successor = createOwnerCommands({
        session: db,
        schema,
        handlers: {},
      });
      await successor.acquire(epoch);
      await assertRejects(() => client.confirm("send", null), Error);
      const next = createOwnerEffectClient(
        {
          session: { query: db.query, transaction: db.transaction },
          schema,
          namespace: "space",
          actionRunId: "run",
        } as Parameters<typeof createOwnerEffectClient>[0],
      );
      assertEquals(await next.begin("send"), { status: "indeterminate" });
    } finally {
      await db.close();
    }
  });
  Deno.test(`${backend}: complete effect inventory enforces its bound without silent truncation`, async () => {
    const db = await createTestDatabase({ url });
    const schema = `effects_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await provisionCopilotzSchema(db, schema);
      const client = createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "run",
      });
      for (let n = 0; n < EFFECT_STEP_LIMIT; n++) {
        await client.begin(`step:${n}`);
      }
      assertEquals((await client.inventory()).length, EFFECT_STEP_LIMIT);
      await assertRejects(() => client.begin("overflow"), Error, "step limit");
      await db.query(
        `INSERT INTO ${
          createCoreTableNames(schema).action_effects
        } (namespace,action_run_id,step,status) VALUES ('space','run','corrupt-extra','begun')`,
      );
      await assertRejects(
        () =>
          readActionEffectInventory(db, {
            schema,
            namespace: "space",
            actionRunId: "run",
          }),
        Error,
        "exceeds its bound",
      );
    } finally {
      await db.close();
    }
  });
}
