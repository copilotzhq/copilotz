import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createBodyStorageRuntime } from "../content/storage.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { createProtectedValueRuntime } from "./protected-value.ts";
import {
  protectedValueReadCheck,
  withProtectedValueRead,
} from "./protected-value-read.ts";

Deno.test("protected policy read bindings are exact, scoped and revocable", async () => {
  const transaction: SqlExecutor = {
    query: () => Promise.resolve({ rows: [] }),
  };
  const scope = { databaseSchema: "binding", namespace: "space" };
  const controller = new AbortController();
  let current = true;
  let retained: (() => Promise<void>) | undefined;
  await withProtectedValueRead(transaction, scope, controller.signal, () => {
    if (!current) throw new Error("Invocation retired.");
  }, async () => {
    retained = protectedValueReadCheck(transaction, scope);
    await retained!();
    assertEquals(protectedValueReadCheck({ ...transaction }, scope), undefined);
    assertThrows(
      () =>
        protectedValueReadCheck(transaction, { ...scope, namespace: "other" }),
      Error,
      "another scope",
    );
    assertThrows(
      () =>
        protectedValueReadCheck(transaction, {
          ...scope,
          databaseSchema: "another",
        }),
      Error,
      "another scope",
    );
    current = false;
    await assertRejects(retained!, Error, "Invocation retired");
    current = true;
  });
  assertEquals(protectedValueReadCheck(transaction, scope), undefined);
  await assertRejects(retained!, Error, "closed");
  controller.abort(new Error("Owner lost."));
  await assertRejects(
    () =>
      withProtectedValueRead(
        transaction,
        scope,
        controller.signal,
        () => {},
        () => Promise.resolve(),
      ),
    Error,
    "Owner lost",
  );
});

Deno.test("protected owner policy opens a real read snapshot without granting writes", async () => {
  const db = await createTestDatabase();
  const schema = `protected_read_${crypto.randomUUID().replaceAll("-", "")}`;
  const scope = { databaseSchema: schema, namespace: "space" };
  const coordinates = { namespace: "space", ownerId: "root", slot: "input" };
  const controller = new AbortController();
  let current = true;
  let retireAfterDecrypt = false;
  let retained: SqlExecutor | undefined;
  const adapter = await testSecretAdapter();
  const runtime = createProtectedValueRuntime({
    databaseSchema: schema,
    session: db,
    storage: createBodyStorageRuntime({}),
    adapter: {
      seal: adapter.seal,
      async open(input) {
        const plaintext = await adapter.open(input);
        if (retireAfterDecrypt) current = false;
        return plaintext;
      },
    },
  });
  try {
    await provisionCopilotzSchema(db, schema);
    const prepared = await createSchemaCommandRunner(db, schema)(
      "protected.capture",
      {},
      (_input, command) =>
        runtime.prepare(
          coordinates,
          { credential: "synthetic-secret" },
          command.transaction,
        ),
    );
    const snapshot = <T>(run: (facade: SqlExecutor) => Promise<T>) =>
      db.readSnapshot!(async (read) => {
        const facade = Object.freeze({ query: read.query.bind(read) });
        retained = facade;
        return await withProtectedValueRead(
          facade,
          scope,
          controller.signal,
          () => {
            if (!current) throw new Error("Invocation retired.");
          },
          () => run(facade),
        );
      });
    await snapshot(async (facade) => {
      assertEquals(await runtime.open(coordinates, prepared.ref, facade), {
        credential: "synthetic-secret",
      });
      await assertRejects(
        () => runtime.prepare(coordinates, { credential: "new" }, facade),
        Error,
        "current transaction from this database owner",
      );
      await assertRejects(
        () =>
          runtime.open(
            { ...coordinates, namespace: "other" },
            prepared.ref,
            facade,
          ),
        Error,
        "another scope",
      );
      await assertRejects(
        () => runtime.open(coordinates, prepared.ref, { ...facade }),
        Error,
        "current transaction from this database owner",
      );
    });
    await assertRejects(
      () => runtime.open(coordinates, prepared.ref, retained),
      Error,
      "current transaction from this database owner",
    );
    retireAfterDecrypt = true;
    await assertRejects(
      () =>
        snapshot((facade) => runtime.open(coordinates, prepared.ref, facade)),
      Error,
      "Invocation retired",
    );
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
});
