import { createActionEffectController } from "./effects.ts";
import { externalEffect } from "./external-effect.ts";
import type { ActionContext } from "./types.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
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
import { effectKey } from "./effect-client.ts";

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
  Deno.test(`${backend}: recovery inventory includes every own step without descendants or truncation`, async () => {
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
      for (let n = 0; n < 101; n++) {
        await client.begin(`step:${n}`);
      }
      await createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "child",
      }).begin("child-step");
      const inventory = await readActionEffectInventory(db, {
        schema,
        namespace: "space",
        actionRunId: "run",
      });
      assertEquals(inventory.length, 101);
      assertEquals(
        inventory.some((entry) => entry.step === "child-step"),
        false,
      );
      const scopes = await db.query(
        `SELECT 1 FROM ${
          createCoreTableNames(schema).owner_receipts
        } WHERE kind='effect.scope'`,
      );
      assertEquals(scopes.rows.length, 0);
    } finally {
      await db.close();
    }
  });
  Deno.test(`${backend}: effect ingress captures once before a deferred tracker and rejects malformed outcomes`, async () => {
    const db = await createTestDatabase({ url });
    const schema = `effect_capture_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await provisionCopilotzSchema(db, schema);
      const client = createOwnerEffectClient({
        session: db,
        schema,
        namespace: "space",
        actionRunId: "run",
      });
      const signal = new AbortController().signal;
      const effect = createActionEffectController({
        client,
        signal,
        check() {},
        context: () => ({}) as ActionContext,
        track: (start) => Promise.resolve().then(start),
      }).effect;
      await effect.begin("capture");
      const value = { reference: "first" };
      const pending = effect.confirm("capture", value);
      value.reference = "changed";
      await pending;
      assertEquals(await client.inspect("capture"), {
        status: "replay",
        outcome: { reference: "first" },
      });
      for (
        const invalid of [NaN, {
          get value() {
            throw new Error("accessor invoked");
          },
        }, "x".repeat(1024 * 1024 + 1)]
      ) {
        assertThrows(() => client.confirm("invalid", invalid as never));
      }
      let dispatches = 0;
      const dispatch = () => {
        dispatches++;
        return { reference: "provider" };
      };
      assertEquals(
        await externalEffect({ effect, signal }, "helper", dispatch),
        { reference: "provider" },
      );
      assertEquals(
        await externalEffect({ effect, signal }, "helper", dispatch),
        { reference: "provider" },
      );
      assertEquals(dispatches, 1);
    } finally {
      await db.close();
    }
  });
}
