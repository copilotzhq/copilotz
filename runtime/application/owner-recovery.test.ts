import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotz, defineAction, defineCollection } from "../../index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { bindSchemaOwner } from "../engine/commands.ts";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "../authorization/authority.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { provisionOperationCatalog } from "../streams/catalog.ts";
import { reader } from "../testing/subscriptions.ts";
import { createCopilotzGateway } from "./gateway.ts";
import { createCopilotzApplication } from "./application.ts";

async function bounded<T>(work: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("owner recovery exceeded its bound")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const mode of ["local", "worker"] as const) {
  Deno.test(`${mode}: fenced application replaces its owner and interrupts waiting traffic without database reconnect`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
    });
    const schema = `owner_recovery_${crypto.randomUUID().replaceAll("-", "")}`;
    const secondary = `${schema}_secondary`;
    await provisionCopilotzSchema(db, secondary);
    await provisionOperationCatalog(db, secondary);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const options = {
      database: db,
      databaseSchema: schema,
      databaseScopes: [secondary],
      namespace: "scope",
      collections: {
        entry: defineCollection({
          name: "entry",
          schema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        }),
      },
      authorization: {
        policies: {
          app: {
            revision: "1",
            sources: [],
            evaluate: () => ({ collections: { entry: {} } }),
          },
        },
        collections: { entry: { id: "app", revision: "1" } },
        actions: {},
      },
      actions: {
        echo: defineAction({
          id: "recovery.echo",
          async execute(input: { wait?: boolean }) {
            if (input.wait) {
              entered.resolve();
              await release.promise;
            }
            return "ok";
          },
        }),
      },
    } as const;
    const transport = {
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    } as const;
    const gateway = mode === "worker"
      ? await createCopilotzGateway({
        ...options,
        transports: [transport],
        target: { workerId: "worker" },
      })
      : undefined;
    const app = gateway?.application ??
      await createCopilotzApplication(options);
    const worker = mode === "worker"
      ? await createCopilotz({
        role: "worker",
        id: "worker",
        transport,
        namespace: "scope",
        actions: options.actions,
      })
      : undefined;
    await worker?.ready;
    await app.startRecovery();
    const oldOwner = await bindSchemaOwner(db, schema)();
    const oldScope = await app.databaseScope(schema);
    const oldSecondaryScope = await app.databaseScope(secondary);
    const oldSecondaryOwner = await bindSchemaOwner(db, secondary)();
    const authority: AuthenticatedAuthority = {
      version: 1,
      principal: { kind: "api-key", id: "key" },
      scope: {
        owner: "schema",
        databaseSchema: schema,
        tenant: "tenant",
        namespace: "scope",
        bindings: {},
      },
      validity: credentialValidity(new Date()),
      policy: { id: "app", revision: "1" },
      requestFacts: {
        endpoint: "entries",
        transport: "http",
        operation: "read",
        params: {},
        input: null,
      },
      provenance: { ingress: "http", source: "request" },
      dependencies: [],
      authorityBasis: { kind: "credential", id: "key" },
    };
    try {
      const subscription = await app.observeCollection(authority, "entry");
      const frames = reader(subscription);
      assertEquals((await frames.next()).t, "snapshot");
      assertEquals(await app.host.actions.echo({}), "ok");
      const pending = app.host.actions.echo({ wait: true }, {
        idempotencyKey: "waiting",
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await bounded(entered.promise);
      const operations = await app.listOperations({});
      const waiting = operations.find((operation) =>
        operation.correlationId === "host:waiting"
      );
      assert(waiting);
      const attachment = await app.attach({ operationId: waiting.operationId });
      const observed = attachment.done.then(
        () => ({ ok: true }),
        (error) => ({ error }),
      );
      // A completed competing acquisition has fenced this runtime, as can happen
      // during failover after a transport lease expires. SQL epochs do not expire.
      await db.query(
        `UPDATE "${secondary}".owner_epochs SET epoch=epoch+1,holder=$1 WHERE owner='schema'`,
        [crypto.randomUUID()],
      );
      await assertRejects(() =>
        oldSecondaryScope.events.append({
          type: "probe",
          namespace: "scope",
          payload: {},
        })
      );
      assertEquals((await bounded(frames.next())).t, "reset");
      const reset = await bounded(observed);
      assert("error" in reset);
      assertEquals(reset.error.code, "observation_reset_required");
      await attachment.detach();
      const outcome = await bounded(pending);
      assert(
        "error" in outcome,
        "pending client must be interrupted at owner loss",
      );
      assertEquals(outcome.error.status, 503);
      assertEquals(outcome.error.retryable, true);
      assertEquals(await bounded(app.host.actions.echo({})), "ok");
      const next = await bindSchemaOwner(db, schema)();
      assert(next !== oldOwner);
      assertEquals(next.epoch, oldOwner.epoch! + 1);
      assertEquals(
        (await bindSchemaOwner(db, secondary)()).epoch,
        oldSecondaryOwner.epoch! + 2,
      );
      await (await app.databaseScope(secondary)).events.append({
        type: "recovered",
        namespace: "scope",
        payload: {},
      });
      assertEquals(oldOwner.state, "stopped");
      const fresh = await app.observeCollection(authority, "entry");
      assertEquals((await bounded(reader(fresh).next())).t, "snapshot");
      fresh.detach();
      const observer = await app.attach({
        operationId: operations.find((operation) =>
          operation.state === "completed"
        )!.operationId,
      });
      for await (const _output of observer.outputs) {
        /* drain finite replay */
      }
      await bounded(observer.done);
      await observer.detach();
      await assertRejects(() =>
        oldScope.events.append({
          type: "stale",
          namespace: "scope",
          payload: {},
        })
      );
    } finally {
      release.resolve();
      await worker?.close();
      if (gateway) await gateway.close();
      else await app.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.query(`DROP SCHEMA "${secondary}" CASCADE`);
      await db.close();
    }
  });
}

for (const failure of ["blocked", "failed"] as const) {
  Deno.test(`owner replacement ${failure} gives bounded retryable admission and later recovers`, async () => {
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
    });
    const schema = `owner_bound_${crypto.randomUUID().replaceAll("-", "")}`;
    const entering = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let activations = 0;
    const app = await createCopilotzApplication(
      {
        database: db,
        databaseSchema: schema,
        namespace: "scope",
        databaseRecovery: {
          waitMs: failure === "blocked" ? 20 : 2_000,
          retryAfterSeconds: 3,
        },
        actions: {
          echo: defineAction({ id: "bound.echo", execute: () => "ok" }),
        },
      },
      {},
      async () => {
        if (++activations === 2) {
          entering.resolve();
          if (failure === "blocked") await release.promise;
          else throw new Error("activation unavailable");
        }
      },
    );
    try {
      const old = await app.databaseScope(schema);
      await db.query(
        `UPDATE "${schema}".owner_epochs SET epoch=epoch+1,holder=$1 WHERE owner='schema'`,
        [crypto.randomUUID()],
      );
      await assertRejects(() =>
        old.events.append({ type: "probe", namespace: "scope", payload: {} })
      );
      await bounded(entering.promise);
      const errors = await bounded(
        Promise.all(
          Array.from(
            { length: 5 },
            () => app.host.actions.echo({}).then(() => null, (error) => error),
          ),
        ),
      );
      for (const error of errors) {
        assertEquals(error?.status, 503);
        assertEquals(error?.retryable, true);
        assertEquals(error?.retryAfterSeconds, 3);
      }
      assertEquals(activations, 2, "concurrent callers share one replacement");
      release.resolve();
      // Explicit recovery shares the in-progress replacement. After a failed
      // attempt a new ingress can retry, without a background fencing loop.
      if (failure === "blocked") await bounded(app.recoverAll());
      assertEquals(await bounded(app.host.actions.echo({})), "ok");
      assertEquals(activations, failure === "blocked" ? 2 : 3);
    } finally {
      release.resolve();
      await app.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
}

Deno.test("shutdown cancels recovery admission and drains the replacement without restarting it", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
  });
  const schema = `owner_close_${crypto.randomUUID().replaceAll("-", "")}`;
  const entering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let activations = 0;
  const app = await createCopilotzApplication(
    {
      database: db,
      databaseSchema: schema,
      namespace: "scope",
      databaseRecovery: { waitMs: 60_000 },
    },
    {},
    async () => {
      if (++activations === 2) {
        entering.resolve();
        await release.promise;
      }
    },
  );
  try {
    const old = await app.databaseScope(schema);
    await db.query(
      `UPDATE "${schema}".owner_epochs SET epoch=epoch+1,holder=$1 WHERE owner='schema'`,
      [crypto.randomUUID()],
    );
    await assertRejects(() =>
      old.events.append({ type: "probe", namespace: "scope", payload: {} })
    );
    await bounded(entering.promise);
    const owner = await bindSchemaOwner(db, schema)();
    const waiting = app.databaseScope(schema).then(
      () => null,
      (error) => error,
    );
    const closed = app.close();
    assert(await bounded(waiting) instanceof Error);
    release.resolve();
    await bounded(closed);
    assertEquals(owner.state, "stopped");
    assertEquals(activations, 2);
    await assertRejects(() => app.databaseScope(schema));
  } finally {
    release.resolve();
    await app.close();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
