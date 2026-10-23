import { assertEquals } from "@std/assert";
import { openManagedOminipgDatabase } from "./ominipg.ts";
import { usesExclusiveReadSnapshot } from "../events/snapshot-kind.ts";
import { createCopilotzEngine } from "../engine/index.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";

for (
  const [backend, url] of [
    ["PGlite", ":memory:"],
    ["PostgreSQL", Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")],
  ] as const
) {
  Deno.test({
    name:
      `${backend} one-connection owner snapshot stays consistent while a writer queues`,
    ignore: !url,
    async fn() {
      const managed = await openManagedOminipgDatabase({ url, pgPoolMax: 1 });
      assertEquals(
        usesExclusiveReadSnapshot(managed.session.withReadSnapshot),
        true,
      );
      const schema = `perf_snapshot_${crypto.randomUUID().replaceAll("-", "")}`;
      const registry = createPluginRegistry({
        plugins: [
          definePlugin({
            id: "snapshot",
            version: "1",
            collections: {
              note: defineCollection({
                name: "note",
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    value: { type: "number" },
                  },
                  required: ["id", "value"],
                },
              }),
            },
          }),
        ],
      });
      const engine = await createCopilotzEngine({
        session: managed.session,
        registry,
        defaultDatabaseSchema: schema,
      });
      const notes = engine.collections.withScope({ namespace: "test" }).note;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let reading: Promise<unknown> | undefined,
        writing: Promise<unknown> | undefined;
      try {
        await notes.create({ id: "n", value: 1 });
        reading = engine.collections.readSnapshot(
          { namespace: "test" },
          async ({ collections }) => {
            const before = await collections.note.get({ id: "n" });
            entered.resolve();
            await release.promise;
            const after = await collections.note.list({ where: { id: "n" } });
            return [before?.value, after[0]?.value];
          },
        );
        await Promise.race([entered.promise, reading]);
        writing = notes.update({ id: "n", set: { value: 2 } });
        release.resolve();
        assertEquals(await reading, [1, 1]);
        await writing;
        assertEquals((await notes.get({ id: "n" }))?.value, 2);
      } finally {
        release.resolve();
        await Promise.allSettled([reading, writing]);
        await engine.shutdown();
        await managed.session.query(`DROP SCHEMA "${schema}" CASCADE`);
        await managed.close();
      }
    },
  });
}
