import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createContentCatalog, openLogicalBody } from "./catalog.ts";
import { createMemoryBodyStore } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { recoverLogicalBody } from "./maintenance.ts";
import { createContentStreamRuntime } from "../streams/stream.ts";
import { promoteLogicalBody } from "./promoted-body-store.ts";
const schema = "content_catalog_test", namespace = "namespace-a";
const bytes = (value: string) => new TextEncoder().encode(value);
async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  if (Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")) {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await provisionCopilotzSchema(db, schema);
  return {
    db,
    catalog: createContentCatalog(db, schema),
    store: createMemoryBodyStore(),
  };
}
async function reserved(f: Awaited<ReturnType<typeof fixture>>, id = "body-a") {
  const identity = { bodyId: id, writerId: `writer:${id}`, generation: 1 };
  await f.catalog.reserve({
    ...identity,
    namespace,
    copy: {
      key: `copy:${id}`,
      backendKind: f.store.kind,
      backendId: f.store.backendId,
    },
  });
  const writer = await f.store.reserve({
    bodyId: `copy:${id}`,
    mediaType: "text/plain",
    reservationId: identity.writerId,
    generation: 1,
  });
  return { identity, writer };
}
Deno.test("catalog checkpoints are exact receipts and revocation excludes renewal", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await reserved(f);
    await f.store.append({
      writer,
      appendId: "a",
      expectedOffset: 0,
      bytes: bytes("head"),
    });
    assertEquals(
      await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 4 }),
      4,
    );
    assertEquals(
      await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 4 }),
      4,
    );
    await assertRejects(() =>
      f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 5 })
    );
    await f.catalog.renew({
      ...identity,
      deadline: new Date(Date.now() + 120000).toISOString(),
    });
    await f.catalog.beginRevocation(identity);
    await assertRejects(() =>
      f.catalog.renew({
        ...identity,
        deadline: new Date(Date.now() + 240000).toISOString(),
      })
    );
    const advanced = await f.store.fence({ writer });
    await assertRejects(() =>
      f.store.append({
        writer,
        appendId: "b",
        expectedOffset: 4,
        bytes: bytes("tail"),
      })
    );
    assertEquals(await f.catalog.revoked(identity), 4);
    await f.store.terminate({
      writer: advanced,
      expectedByteLength: 4,
      expectedDigest: await digestContent(bytes("head")),
    });
  } finally {
    await f.db.close();
  }
});
Deno.test("recovery bounds reads to the accepted prefix and records one immutable terminal", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await reserved(f);
    await f.store.append({
      writer,
      appendId: "a",
      expectedOffset: 0,
      bytes: bytes("head"),
    });
    await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 4 });
    await f.store.append({
      writer,
      appendId: "b",
      expectedOffset: 4,
      bytes: bytes("tail"),
    });
    await f.catalog.beginRevocation(identity);
    assertEquals(
      await recoverLogicalBody(
        f.catalog,
        (await f.catalog.read(identity.bodyId))!,
        f.store,
      ),
      "terminated",
    );
    const terminal = (await f.catalog.read(identity.bodyId))!.terminal;
    assertEquals(terminal?.length, 4);
    assertEquals(terminal?.outcome, "failed");
    assertEquals(
      await new Response(
        await openLogicalBody(f.catalog, identity.bodyId, () => f.store),
      ).text(),
      "head",
    );
    assertEquals(
      await recoverLogicalBody(
        f.catalog,
        (await f.catalog.read(identity.bodyId))!,
        f.store,
      ),
      "deferred",
    );
    assertEquals((await f.catalog.read(identity.bodyId))!.terminal, terminal);
  } finally {
    await f.db.close();
  }
});
Deno.test("physical Ready without catalog seal acceptance never means completed", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await reserved(f);
    const data = bytes("done"), digest = await digestContent(data);
    await f.store.append({
      writer,
      appendId: "a",
      expectedOffset: 0,
      bytes: data,
    });
    await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 4 });
    await f.store.seal({
      writer,
      expectedByteLength: 4,
      expectedDigest: digest,
    });
    await f.catalog.beginRevocation(identity);
    await recoverLogicalBody(
      f.catalog,
      (await f.catalog.read(identity.bodyId))!,
      f.store,
    );
    assertEquals(
      (await f.catalog.read(identity.bodyId))!.terminal?.outcome,
      "failed",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("seal intent plus exact Ready digest completes after acknowledgement loss", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await reserved(f);
    const data = bytes("done"), digest = await digestContent(data);
    await f.store.append({
      writer,
      appendId: "a",
      expectedOffset: 0,
      bytes: data,
    });
    await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 4 });
    await f.catalog.sealIntent({ ...identity, length: 4, digest });
    const head = await f.store.seal({
      writer,
      expectedByteLength: 4,
      expectedDigest: digest,
    });
    assertEquals((await f.catalog.read(identity.bodyId))!.terminal, undefined);
    await recoverLogicalBody(
      f.catalog,
      (await f.catalog.read(identity.bodyId))!,
      f.store,
    );
    assertEquals(
      (await f.catalog.read(identity.bodyId))!.terminal?.outcome,
      "completed",
    );
    assertEquals(
      (await f.catalog.read(identity.bodyId))!.copy.versionToken,
      head.versionToken,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("stream close persists pending descriptor before terminal publication", async () => {
  const f = await fixture();
  try {
    let published = false;
    const runtime = createContentStreamRuntime({
      namespace,
      store: f.store,
      catalog: f.catalog,
      onOpen(_s, p) {
        p.established();
      },
      async onSeal(opened, head) {
        const ref = {
          type: "content.pending" as const,
          pendingRef: `pending:content-streams/${namespace}/${opened.id}`,
          mediaType: head.mediaType,
          byteLength: head.byteLength,
          digest: head.digest,
        };
        assertEquals(
          (await f.catalog.resolvePending(namespace, ref)).body.terminal
            ?.outcome,
          "completed",
        );
        published = true;
      },
    });
    const writer = await runtime.open({
      id: "stream-a",
      mediaType: "text/plain",
      role: "assistant",
    });
    await writer.append({ appendId: "one", bytes: bytes("hello") });
    assertEquals(
      await writer.append({ appendId: "one", bytes: bytes("hello") }),
      { startOffset: 0, endOffset: 5 },
    );
    await assertRejects(() =>
      writer.append({ appendId: "one", bytes: bytes("other") })
    );
    const ref = await writer.close({ assetId: "unused-id" });
    assertEquals(ref.type, "content.pending");
    assertEquals(published, true);
    assertEquals(
      await new Response((await runtime.follow({ id: writer.id })).body).text(),
      "hello",
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("promotion verification failure preserves current copy and clears target", async () => {
  const f = await fixture();
  try {
    const { identity, writer } = await reserved(f);
    const data = bytes("safe"), digest = await digestContent(data);
    await f.store.append({
      writer,
      appendId: "a",
      expectedOffset: 0,
      bytes: data,
    });
    await f.catalog.checkpoint({ ...identity, expectedOffset: 0, offset: 4 });
    await f.catalog.sealIntent({ ...identity, length: 4, digest });
    await f.catalog.sealAccepted({
      ...identity,
      head: await f.store.seal({
        writer,
        expectedByteLength: 4,
        expectedDigest: digest,
      }),
    });
    const target = createMemoryBodyStore();
    await target.put({
      bodyId: "target",
      bytes: bytes("bad"),
      mediaType: "text/plain",
      digest: await digestContent(bytes("bad")),
    });
    assertEquals(
      await promoteLogicalBody({
        catalog: f.catalog,
        bodyId: identity.bodyId,
        storeFor: () => f.store,
        target,
        targetKey: "target",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      }),
      false,
    );
    assertEquals(
      (await f.catalog.read(identity.bodyId))!.copy.key,
      "copy:body-a",
    );
    assertEquals(
      (await f.catalog.read(identity.bodyId))!.promotionTarget,
      undefined,
    );
  } finally {
    await f.db.close();
  }
});
Deno.test("unknown checkpoint outcomes fail the attempt at the catalog receipt, without splicing retries", async () => {
  const f = await fixture();
  try {
    let apply = false;
    for (const id of ["before", "after"]) {
      const faulty = {
        ...f.catalog,
        async checkpoint(input: Parameters<typeof f.catalog.checkpoint>[0]) {
          if (apply) await f.catalog.checkpoint(input);
          throw new Error("unknown checkpoint result");
        },
      };
      const runtime = createContentStreamRuntime({
          namespace,
          store: f.store,
          catalog: faulty,
          onOpen(_s, p) {
            p.established();
          },
        }),
        writer = await runtime.open({
          id,
          mediaType: "text/plain",
          role: "content",
        });
      await assertRejects(() =>
        writer.append({ appendId: "one", bytes: bytes("prefix") })
      );
      await writer.abort();
      const logical = await f.catalog.read(
        `content-streams/${namespace}/${id}`,
      );
      assertEquals(logical?.terminal?.outcome, "failed");
      assertEquals(logical?.terminal?.length, apply ? 6 : 0);
      await assertRejects(() =>
        writer.append({ appendId: "two", bytes: bytes("tail") })
      );
      apply = true;
    }
  } finally {
    await f.db.close();
  }
});
Deno.test("one outstanding append owns caller bytes and rejects over-bound chunks", async () => {
  const f = await fixture();
  try {
    let calls = 0, release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => entered = resolve);
    const held = new Promise<void>((resolve) => release = resolve);
    const store = {
      ...f.store,
      async append(input: Parameters<typeof f.store.append>[0]) {
        calls++;
        if (calls === 1) {
          entered();
          await held;
        }
        return await f.store.append(input);
      },
    };
    const runtime = createContentStreamRuntime({
        namespace,
        store,
        catalog: f.catalog,
        onOpen(_s, p) {
          p.established();
        },
      }),
      writer = await runtime.open({
        id: "serialized",
        mediaType: "text/plain",
        role: "content",
      });
    const owned = bytes("a"),
      first = writer.append({ appendId: "one", bytes: owned });
    owned[0] = 122;
    const second = writer.append({ appendId: "two", bytes: bytes("b") });
    await started;
    assertEquals(calls, 1);
    release();
    await Promise.all([first, second]);
    await writer.close({ assetId: "unused" });
    assertEquals(
      await new Response((await runtime.follow({ id: writer.id })).body).text(),
      "ab",
    );
    const next = await runtime.open({
      id: "bounded",
      mediaType: "text/plain",
      role: "content",
    });
    let rejected = false;
    try {
      await next.append({
        appendId: "oversize",
        bytes: new Uint8Array(1024 * 1024 + 1),
      });
    } catch {
      rejected = true;
    }
    assertEquals(rejected, true);
    await next.abort();
  } finally {
    await f.db.close();
  }
});
Deno.test("quiet owner-local writers renew catalog protection independently of append I/O", async () => {
  const f = await fixture();
  try {
    let renewals = 0;
    const catalog = {
      ...f.catalog,
      async renew(input: Parameters<typeof f.catalog.renew>[0]) {
        renewals++;
        return await f.catalog.renew(input);
      },
    };
    const runtime = createContentStreamRuntime({
        namespace,
        store: f.store,
        catalog,
        protectionMs: 40,
        onOpen(_s, p) {
          p.established();
        },
      }),
      writer = await runtime.open({
        id: "quiet",
        mediaType: "text/plain",
        role: "content",
      });
    await new Promise((resolve) => setTimeout(resolve, 110));
    assertEquals(renewals >= 2, true);
    const logical =
      (await f.catalog.read(`content-streams/${namespace}/quiet`))!;
    assertEquals(Date.parse(logical.protectedUntil) > Date.now(), true);
    assertEquals(logical.terminal, undefined);
    await writer.abort();
  } finally {
    await f.db.close();
  }
});
Deno.test("catalog alarm deadlines are durable and unsupported stores never schedule collection", async () => {
  const f = await fixture();
  try {
    const { createSchemaCommandRunner } = await import("../engine/commands.ts");
    const writer = { bodyId: "deadline", writerId: "writer", generation: 1 };
    await f.catalog.reserve({
      ...writer,
      namespace,
      protectForMs: 0,
      copy: {
        key: "deadline-copy",
        backendKind: f.store.kind,
        backendId: f.store.backendId,
        collectable: true,
      },
    });
    const head = await f.store.put({
      bodyId: "deadline-copy",
      bytes: bytes("safe"),
      mediaType: "text/plain",
      digest: await digestContent(bytes("safe")),
    });
    await f.catalog.checkpoint({ ...writer, expectedOffset: 0, offset: 4 });
    await f.catalog.sealIntent({ ...writer, length: 4, digest: head.digest });
    await f.catalog.sealAccepted({ ...writer, head });
    const initial = await f.catalog.nextDeadline();
    assertEquals(initial !== null, true);
    assertEquals(Date.parse(initial!) > Date.now(), true);
    await f.catalog.deferRetirement("deadline-copy");
    const retry = await f.catalog.nextDeadline();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(await f.catalog.nextDeadline(), retry);
    await createSchemaCommandRunner(f.db, schema)(
      "test.unsupported",
      {},
      async (_, { transaction }) => {
        await transaction.query(
          `UPDATE "${schema}".content_copies SET collectable=FALSE`,
        );
      },
    );
    assertEquals(await f.catalog.nextDeadline(), null);
  } finally {
    await f.db.close();
  }
});
Deno.test("owner lifetime abort during physical reserve or publication never returns a live writer", async () => {
  const f = await fixture();
  try {
    for (const phase of ["reserve", "publish"]) {
      const lifetime = new AbortController();
      let renewals = 0;
      const catalog = {
        ...f.catalog,
        renew(input: Parameters<typeof f.catalog.renew>[0]) {
          renewals++;
          return f.catalog.renew(input);
        },
      };
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => release = resolve),
        started = new Promise<void>((resolve) => entered = resolve);
      const store = {
        ...f.store,
        async reserve(input: Parameters<typeof f.store.reserve>[0]) {
          const writer = await f.store.reserve(input);
          if (phase === "reserve") {
            entered();
            await held;
          }
          return writer;
        },
      };
      const runtime = createContentStreamRuntime({
        namespace,
        store,
        catalog,
        signal: lifetime.signal,
        protectionMs: 20,
        onOpen(_s, p) {
          p.established();
          if (phase === "publish") {
            lifetime.abort(new DOMException("cancelled", "AbortError"));
          }
        },
      });
      const opening = runtime.open({
        id: `abort-${phase}`,
        mediaType: "text/plain",
        role: "body",
      });
      if (phase === "reserve") {
        await started;
        lifetime.abort(new DOMException("cancelled", "AbortError"));
        release();
      }
      await assertRejects(() => opening);
      const logical =
        (await f.catalog.read(`content-streams/${namespace}/abort-${phase}`))!;
      assertEquals(logical.revocation, "revoked");
      assertEquals(logical.terminal?.length, 0);
      assertEquals(
        logical.terminal?.outcome,
        "cancelled",
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertEquals(renewals, 0);
    }
  } finally {
    await f.db.close();
  }
});
Deno.test("catalog alarm query has indexed due branches and bounded candidate merge", async () => {
  const f = await fixture();
  try {
    const indexes = await f.db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname=$1",
      [schema],
    );
    const names = new Set(indexes.rows.map((row) => row.indexname));
    for (
      const name of [
        "content_logical_recovery_due_idx",
        "content_logical_promotion_due_idx",
        "content_logical_protection_due_idx",
        "content_copies_retirement_due_idx",
        "pending_content_expiry_idx",
        "pending_content_body_expiry_idx",
        "nodes_ready_content_body_idx",
      ]
    ) assertEquals(names.has(name), true, `Missing deadline index: ${name}`);
    await f.db.transaction(async (tx) => {
      // Prove all lookups have an indexed path, independently of the cost
      // preference for sequential scans in this intentionally tiny fixture.
      await tx.query("SET LOCAL enable_seqscan=off");
      await tx.query("SET LOCAL enable_hashjoin=off");
      await tx.query("SET LOCAL enable_mergejoin=off");
      const statements: string[] = [];
      const query: typeof tx.query = (sql, parameters) => {
        statements.push(sql);
        return tx.query(sql, parameters);
      };
      assertEquals(await f.catalog.nextDeadline({ query }), null);
      const sql = statements.find((sql) => sql.includes("MIN(deadline)"))!;
      const explained = await tx.query(`EXPLAIN (FORMAT JSON) ${sql}`);
      const plan = JSON.stringify(explained.rows);
      const referenceLookups: Record<string, unknown>[] = [];
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const node = value as Record<string, unknown>;
        if (node["Index Name"] === "nodes_ready_content_body_idx") {
          referenceLookups.push(node);
        }
        for (const child of Object.values(node)) visit(child);
      };
      visit(explained.rows);
      assertEquals(referenceLookups.length > 0, true);
      for (const lookup of referenceLookups) {
        // An index scan with only a Filter still walks every ready asset for
        // each candidate. The identity collation must permit a keyed lookup.
        assertEquals(
          String(lookup["Index Cond"]).includes("body_id"),
          true,
          JSON.stringify(lookup),
        );
      }
      // PostgreSQL may introduce another Limit for the MIN expression's
      // init-plan. The six explicit branches, each LIMIT 1, are the bound.
      assertEquals((sql.match(/LIMIT 1/g) ?? []).length, 6);
      assertEquals(
        (plan.match(/"Node Type":"Limit"/g) ?? []).length >= 6,
        true,
      );
      assertEquals(plan.includes('"Node Type":"Seq Scan"'), false);
      for (
        const name of [
          "content_logical_recovery_due_idx",
          "content_logical_promotion_due_idx",
          "pending_content_expiry_idx",
          "nodes_ready_content_body_idx",
          "pending_content_body_expiry_idx",
        ]
      ) {
        assertEquals(
          plan.includes(name),
          true,
          `Unindexed deadline path: ${name}`,
        );
      }
    });
  } finally {
    await f.db.close();
  }
});
