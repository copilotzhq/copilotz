import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { captureCollectionPolicy } from "../collections/policy-authorization.ts";
import type { CollectionPolicyContext } from "../collections/policy-types.ts";
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
    // Exercise the actual Collection policy facade, not just its private marker.
    let savedContext: CollectionPolicyContext | undefined;
    let policyReads = 0;
    let currentChecks = 0;
    const policy = captureCollectionPolicy({
      registration: {
        alias: "records",
        name: "record",
        policy: {
          async authorize(_intent, context) {
            savedContext = context;
            const original = await context.resolveSource();
            assertEquals(original.data, { credential: "synthetic-secret" });
            policyReads++;
          },
        },
      },
      databaseSchema: schema,
      namespace: "space",
      method: "get",
      args: { id: "record" },
    }, {
      scope,
      signal: controller.signal,
      invocation: { kind: "action", id: "record.read", runId: "read-run" },
      check() {
        controller.signal.throwIfAborted();
      },
      assertCurrent() {
        currentChecks++;
        if (!current) throw new Error("Invocation retired.");
        return Promise.resolve();
      },
      async resolveSource(transaction) {
        assertEquals(
          typeof protectedValueReadCheck(transaction, scope),
          "function",
        );
        return {
          event: {
            id: "root",
            type: "action.invoked",
            namespace: "space",
            metadata: {},
          },
          data: await runtime.open(coordinates, prepared.ref, transaction),
          ancestors: [],
        };
      },
    });
    await db.readSnapshot!(async (transaction) => {
      const read = { transaction, commandTime: new Date().toISOString() };
      await policy.authorize(read, "read");
      await policy.authorize(read, "result", { id: "record" });
    });
    assertEquals(policyReads, 2);
    assertEquals(currentChecks > 4, true);
    assertThrows(() => savedContext!.resolveSource(), Error, "closed");
    current = false;
    await assertRejects(
      () =>
        db.readSnapshot!((transaction) =>
          policy.authorize(
            { transaction, commandTime: new Date().toISOString() },
            "result",
            { id: "record" },
          )
        ),
      Error,
      "Invocation retired",
    );
    assertEquals(policyReads, 2);
    current = true;
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
