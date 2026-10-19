import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { createContentCatalog } from "./catalog.ts";
import { createMemoryBodyStore } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import {
  maintainProgressiveBodies,
  recoverLogicalBody,
} from "./maintenance.ts";
const schema = "content_recovery_test";
async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await provisionCopilotzSchema(db, schema);
  const catalog = createContentCatalog(db, schema),
    store = createMemoryBodyStore();
  return {
    db,
    catalog,
    store,
    async reserve(id: string, protectForMs = 0) {
      const identity = { bodyId: id, writerId: id, generation: 1 };
      await catalog.reserve({
        ...identity,
        namespace: "namespace-a",
        copy: { key: id, backendKind: store.kind, backendId: store.backendId },
        protectForMs,
      });
      const writer = await store.reserve({
        bodyId: id,
        mediaType: "text/plain",
        reservationId: id,
        generation: 1,
      });
      return { identity, writer };
    },
  };
}
Deno.test("catalog maintenance freezes expired accepted prefixes without semantic lookup", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await f.reserve("body-a");
    const bytes = new TextEncoder().encode("partial");
    await f.store.append({ writer, appendId: "one", expectedOffset: 0, bytes });
    await f.catalog.checkpoint({
      ...identity,
      expectedOffset: 0,
      offset: bytes.length,
    });
    const result = await maintainProgressiveBodies(f.catalog, () => f.store);
    assertEquals(result.terminated, 1);
    assertEquals(result.errors, []);
    assertEquals(
      (await f.store.head({ bodyId: identity.bodyId }))?.state,
      "open",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("catalog recovery pages skip quiet protected writers without starving expiry", async () => {
  const f = await fixture();
  try {
    await f.reserve("a-live", 60000);
    await f.reserve("b-live", 60000);
    await f.reserve("z-expired");
    const result = await maintainProgressiveBodies(f.catalog, () => f.store, {
      limit: 1,
    });
    assertEquals(result.terminated, 1);
    assertEquals(result.after, "z-expired");
    assertEquals((await f.catalog.read("a-live"))?.terminal, undefined);
    assertEquals((await f.store.head({ bodyId: "a-live" }))?.state, "open");
  } finally {
    await f.db.close();
  }
});
Deno.test("recovery completes a matching seal-intent prefix and drops later tentative bytes", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await f.reserve("intent");
    const prefix = new TextEncoder().encode("good"),
      digest = await digestContent(prefix);
    await f.store.append({
      writer,
      appendId: "one",
      expectedOffset: 0,
      bytes: prefix,
    });
    await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 4 });
    await f.catalog.sealIntent({ ...identity, length: 4, digest });
    await f.store.append({
      writer,
      appendId: "late",
      expectedOffset: 4,
      bytes: new Uint8Array([9]),
    });
    const result = await maintainProgressiveBodies(f.catalog, () => f.store);
    assertEquals(result.sealed, 1);
    assertEquals(result.errors, []);
    assertEquals((await f.store.head({ bodyId: "intent" }))?.byteLength, 4);
    assertEquals((await f.catalog.read("intent"))?.terminal, {
      outcome: "completed",
      length: 4,
      digest,
    });
  } finally {
    await f.db.close();
  }
});
Deno.test("mismatching seal intent fails at the committed prefix and repeated recovery is immutable", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await f.reserve("mismatch");
    await f.store.append({
      writer,
      appendId: "one",
      expectedOffset: 0,
      bytes: new Uint8Array([1]),
    });
    await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 1 });
    await f.catalog.sealIntent({
      ...identity,
      length: 1,
      digest: await digestContent(new Uint8Array([2])),
    });
    assertEquals(
      (await maintainProgressiveBodies(f.catalog, () => f.store)).terminated,
      1,
    );
    const recorded = (await f.catalog.read("mismatch"))!;
    assertEquals(recorded.terminal?.outcome, "failed");
    assertEquals(
      await recoverLogicalBody(f.catalog, recorded, f.store),
      "deferred",
    );
    assertEquals(
      (await f.catalog.read("mismatch"))?.terminal,
      recorded.terminal,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("renewal ordered before an expiry claim keeps the writer alive", async () => {
  const f = await fixture();
  try {
    const { identity } = await f.reserve("renewed");
    const stale = (await f.catalog.recoveryCandidates())[0];
    await f.catalog.renew({
      ...identity,
      deadline: new Date(Date.now() + 60000).toISOString(),
    });
    assertEquals(
      await recoverLogicalBody(f.catalog, stale, f.store),
      "deferred",
    );
    assertEquals((await f.catalog.read("renewed"))?.revocation, "active");
  } finally {
    await f.db.close();
  }
});
Deno.test("transient storage failure leaves recovery retryable without inventing a terminal", async () => {
  const f = await fixture();
  try {
    await f.reserve("retry");
    let unavailable = true;
    const faulty = {
      ...f.store,
      head(input: { bodyId: string }) {
        if (unavailable) throw new Error("temporary transport failure");
        return f.store.head(input);
      },
    };
    const first = await maintainProgressiveBodies(f.catalog, () => faulty);
    assertEquals(first.errors.length, 1);
    assertEquals((await f.catalog.read("retry"))?.terminal, undefined);
    unavailable = false;
    await createSchemaCommandRunner(f.db, schema)(
      "test.retry",
      {},
      async (_, { transaction }) => {
        await transaction.query(
          `UPDATE "${schema}".content_logical_bodies SET recovery_after=NOW()-INTERVAL '1 second'`,
        );
      },
    );
    assertEquals(
      (await maintainProgressiveBodies(f.catalog, () => faulty)).terminated,
      1,
    );
    await createSchemaCommandRunner(f.db, schema)(
      "test.expire",
      {},
      async (_, { transaction }) => {
        await transaction.query(
          `UPDATE "${schema}".content_logical_bodies SET protected_until=NOW()-INTERVAL '1 second'`,
        );
      },
    );
    await assertRejects(() =>
      f.catalog.renew({
        bodyId: "retry",
        writerId: "retry",
        generation: 1,
        deadline: new Date(Date.now() + 60000).toISOString(),
      })
    );
  } finally {
    await f.db.close();
  }
});

Deno.test("missing failed-prefix bytes cannot postpone the accepted failure", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await f.reserve("missing-prefix");
    await f.store.append({
      writer,
      appendId: "one",
      expectedOffset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 3 });
    const unavailable = {
      ...f.store,
      readRange() {
        throw new Error("missing prefix bytes");
      },
      terminate() {
        throw new Error("must not normalize a failure");
      },
    };
    assertEquals(
      await recoverLogicalBody(
        f.catalog,
        (await f.catalog.read(identity.bodyId))!,
        unavailable,
      ),
      "terminated",
    );
    assertEquals((await f.catalog.read(identity.bodyId))?.terminal, {
      outcome: "failed",
      reason: "abandoned",
      length: 3,
    });
  } finally {
    await f.db.close();
  }
});
