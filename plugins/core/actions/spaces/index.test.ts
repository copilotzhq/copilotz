import { storageFixture } from "../../shared/testing/storage-plugin.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineCollection } from "@copilotz/copilotz/collections";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { createCopilotzEngine } from "../../../../runtime/engine/index.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { createTestDomainContext } from "../../shared/testing/context.ts";
import {} from "../../plugin.ts";
import { spaceAttachmentId } from "../../collections/space-attachment/index.ts";
import { type SpaceInput, spacesAction } from "./index.ts";

const databaseUrl = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
for (const url of [":memory:", ...(databaseUrl ? [databaseUrl] : [])]) {
  Deno.test(`Space lifecycle, custom attachments and atomic moves (${url === ":memory:" ? "PGlite" : "PostgreSQL"})`, async () => {
    const db = await createTestDatabase({ url });
    const registry = await createPluginRegistry({
      plugins: [
        storageFixture,
        definePlugin({
          id: "test.spaces",
          version: "1.0.0",
          collections: {
            document: defineCollection({
              name: "custom_document",
              schema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                },
              } as const,
            }),
          },
        }),
      ],
    });
    const schema = "test_spaces_" + crypto.randomUUID().replaceAll("-", "");
    const engine = await createCopilotzEngine({
      session: db,
      registry,
      defaultDatabaseSchema: schema,
      retryBaseMs: 0,
    });
    const context = createTestDomainContext(
      engine,
      `spaces-${crypto.randomUUID()}`,
    );
    const c = context.collections;
    const run = (input: SpaceInput) => context.actions.spaces(input);
    try {
      assertEquals(spacesAction.id, "copilotz.core.spaces");
      await c.participant.create({
        id: "owner",
        externalId: "owner",
        participantType: "human",
      });
      await c.participant.create({
        id: "member",
        externalId: "member",
        participantType: "human",
      });
      await assertRejects(() =>
        run({ operation: "create", spaceId: "bad", ownerId: "absent" })
      );
      for (const spaceId of ["a", "b"]) {
        await run({ operation: "create", spaceId, ownerId: "owner" });
      }
      await run({
        operation: "addMember",
        spaceId: "a",
        participantId: "member",
      });
      await run({
        operation: "addMember",
        spaceId: "a",
        participantId: "member",
      });
      assertEquals((await c.space.get({ id: "a" }))?.memberIds, [
        "owner",
        "member",
      ]);
      await assertRejects(() =>
        run({ operation: "removeMember", spaceId: "a", participantId: "owner" })
      );
      await run({
        operation: "removeMember",
        spaceId: "a",
        participantId: "member",
      });
      assertEquals((await c.space.get({ id: "a" }))?.memberIds, ["owner"]);
      await c.thread.create({ id: "thread" });
      await c.document.create({ id: "doc", title: "Preserve this" });
      const attach = (spaceId: string) =>
        run({
          operation: "attach",
          spaceId,
          collection: "thread",
          recordId: "thread",
        });
      await attach("a");
      await attach("a");
      await run({
        operation: "attach",
        spaceId: "a",
        collection: "document",
        recordId: "doc",
      });
      assertEquals((await c.spaceAttachment.list()).length, 2);
      await assertRejects(() =>
        run({
          operation: "attach",
          spaceId: "a",
          collection: "document",
          recordId: "missing",
        })
      );
      await assertRejects(() =>
        c.spaceAttachment.create({
          id: "wrong",
          collection: "thread",
          recordId: "thread",
          spaceId: "a",
        })
      );
      await run({ operation: "archive", spaceId: "b" });
      await assertRejects(() => attach("b"));
      const attachmentId = spaceAttachmentId("thread", "thread");
      assertEquals(
        (await c.spaceAttachment.get({ id: attachmentId }))?.spaceId,
        "a",
      );
      await run({ operation: "restore", spaceId: "b" });
      await attach("b");
      assertEquals(
        (await c.spaceAttachment.get({ id: attachmentId }))?.spaceId,
        "b",
      );
      await run({
        operation: "detach",
        spaceId: "a",
        collection: "thread",
        recordId: "thread",
      });
      assertEquals(
        (await c.spaceAttachment.get({ id: attachmentId }))?.spaceId,
        "b",
      );
      await run({ operation: "archive", spaceId: "a" });
      assertEquals((await c.space.queries.active()).map((s) => s.id), ["b"]);
      assertEquals(
        (await c.spaceAttachment.queries.bySpace({ spaceId: "a" })).length,
        1,
      );
      await run({ operation: "restore", spaceId: "a" });
      assertEquals((await c.space.queries.active()).length, 2);
      const results = await Promise.allSettled([attach("a"), attach("b")]);
      assert(results.some((r) => r.status === "fulfilled"));
      assertEquals(
        (await c.spaceAttachment.list({
          where: { collection: "thread", recordId: "thread" },
        })).length,
        1,
      );
      const other = createTestDomainContext(engine, "other-namespace");
      assertEquals(await other.collections.space.get({ id: "a" }), null);
      await assertRejects(() =>
        other.actions.spaces({
          operation: "attach",
          spaceId: "a",
          collection: "thread",
          recordId: "thread",
        })
      );
      // Removal must not silently stop at one query page.
      await context.transaction(async (tx) => {
        for (let i = 0; i < 205; i++) {
          const recordId = `bulk-${i}`;
          await tx.collections.document.create({ id: recordId, title: "keep" });
          await tx.collections.spaceAttachment.create({
            id: spaceAttachmentId("custom_document", recordId),
            collection: "custom_document",
            recordId,
            spaceId: "a",
          });
        }
      });
      for (const spaceId of ["a", "b"]) {
        await run({ operation: "remove", spaceId });
      }
      assertEquals((await c.spaceAttachment.list()).length, 0);
      assert(await c.thread.get({ id: "thread" }));
      assertEquals(
        (await c.document.get({ id: "doc" }))?.title,
        "Preserve this",
      );
    } finally {
      await engine.shutdown();
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.close();
    }
  });
}
