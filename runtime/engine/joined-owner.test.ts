import { assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import {
  attachedDatabaseOwner,
  createSchemaCommandRunner,
  joinDatabaseOwnerCommand,
  openDatabaseOwner,
  releaseDatabaseOwner,
  schemaCommandContext,
} from "./commands.ts";

Deno.test("joined destination owner retains its epoch, publication queue and shutdown drain through outer commit or rollback", async () => {
  for (const mode of ["commit", "rollback", "epoch-loss"]) {
    const db = await createOwnerTestDatabase();
    await provisionCopilotzSchema(db, "source");
    await provisionCopilotzSchema(db, "destination");
    const source = await openDatabaseOwner(db, "source");
    const destination = await openDatabaseOwner(db, "destination");
    await db.query("CREATE TABLE destination.probe(id text PRIMARY KEY)");
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publications: string[] = [];
    let closed = false;
    try {
      const writing = createSchemaCommandRunner(
        db,
        "source",
        () => Promise.resolve(source),
      )("test.join", {}, async (_, command) => {
        const owner = await attachedDatabaseOwner(
          command.transaction,
          "destination",
        );
        await joinDatabaseOwnerCommand(command, owner, async (joined) => {
          assertEquals(
            schemaCommandContext(joined.transaction, "destination"),
            joined,
          );
          assertEquals(joined.signal, destination.signal);
          assertEquals(joined.caller.epoch, destination.epoch);
          await joined.transaction.query(
            "INSERT INTO destination.probe VALUES('one')",
          );
          joined.afterCommit(() => {
            publications.push(mode);
          });
          return null;
        });
        admitted.resolve();
        await release.promise;
        assertEquals(publications, []);
        if (mode === "rollback") throw new Error("Injected rollback");
        return null;
      });
      void writing.catch(() => undefined);
      await admitted.promise;
      const closing = destination.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      assertEquals(closed, false);
      if (mode === "epoch-loss") {
        destination.stop(new Error("Injected epoch loss"));
      }
      release.resolve();
      if (mode === "commit") await writing;
      else {await assertRejects(
          () => writing,
          Error,
          mode === "rollback" ? "Injected rollback" : "Injected epoch loss",
        );}
      await closing;
      assertEquals(closed, true);
      assertEquals(publications, mode === "commit" ? [mode] : []);
      assertEquals(
        (await db.query("SELECT id FROM destination.probe")).rows,
        mode === "commit" ? [{ id: "one" }] : [],
      );
    } finally {
      release.resolve();
      await releaseDatabaseOwner(source);
      await releaseDatabaseOwner(destination);
      await db.close();
    }
  }
});
