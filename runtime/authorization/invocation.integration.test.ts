import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { createCopilotz } from "../application/copilotz.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { bindTestActions, testAuthority } from "../testing/authority.ts";
import { type AuthorizationIntent, authorizationRefused } from "./evaluator.ts";
import { withRetainedAuthority } from "./binding.ts";
import { retainedAuthority } from "./authority.ts";

Deno.test("F4 Collection grants use the immediate executing Action, never ingress facts or caller metadata", async () => {
  const database = await createOwnerTestDatabase();
  const seen: AuthorizationIntent[] = [];
  const participants = defineCollection({
    name: "participant",
    ownerPolicy: "required",
    schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    } as const,
  });
  const create = async (input: { id: string }, ctx: ActionContext) => {
    return await ctx.collections.participants.create(input);
  };
  const allowed = defineAction({ id: "threads.create", execute: create });
  const denied = defineAction({ id: "threads.other", execute: create });
  const nested = defineAction({
    id: "threads.parent",
    execute: (input: { id: string }, ctx: ActionContext) =>
      ctx.actions.allowed(input),
  });
  const app = await createCopilotz({
    namespace: "space",
    database,
    actions: { allowed, denied, nested },
    collections: { participants },
    authorization: {
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate({ authority, intent }) {
            if (intent.kind === "collection") {
              seen.push(intent);
              if (
                authority.principal.id !== "member" ||
                intent.invocation?.kind !== "action" ||
                intent.invocation.id !== "threads.create"
              ) authorizationRefused();
            }
            return {
              actions: { allowed: {}, denied: {}, nested: {} },
              collections: { participants: {} },
              collectionMutations: { participants: { create: {} } },
            };
          },
        },
      },
      actions: Object.fromEntries(
        ["allowed", "denied", "nested"].map((
          key,
        ) => [key, { id: "fixture", revision: "1" }]),
      ),
      collections: { participants: { id: "fixture", revision: "1" } },
    },
  });
  const authority = testAuthority("public");
  const forged = { kind: "action", id: "threads.create", runId: "forged-run" };
  const assertInvocation = (id: string) => {
    const invocation = seen.at(-1)?.invocation;
    assertEquals(invocation?.kind, "action");
    assertEquals(invocation?.id, id);
    assert(
      typeof invocation?.runId === "string" && invocation.runId.length > 0,
    );
    assert(invocation.runId !== forged.runId);
  };
  const actions = bindTestActions(app.actions, authority);
  try {
    await assertRejects(() =>
      withRetainedAuthority(
        {
          ...authority,
          requestFacts: {
            ...authority.requestFacts,
            input: { invocation: forged },
          },
        },
        new AbortController().signal,
        () =>
          app.collections.participants.create({
            id: "direct",
            invocation: forged,
          }),
      )
    );
    assertEquals(seen.at(-1)?.invocation, undefined);
    assertThrows(() => retainedAuthority({ ...authority, invocation: forged }));
    await actions.allowed({ id: "allowed" });
    assertInvocation("threads.create");
    await assertRejects(() =>
      actions.denied({ id: "denied" }, { metadata: { invocation: forged } })
    );
    assertInvocation("threads.other");
    await actions.nested({ id: "nested" });
    assertInvocation("threads.create");
    assert(
      seen.every((intent) =>
        !intent.invocation ||
        Object.keys(intent.invocation).sort().join() === "id,kind,runId"
      ),
    );
    assertEquals(
      (await database.query(
        "SELECT id FROM public.nodes WHERE type='participant' ORDER BY id",
      )).rows,
      [{ id: "allowed" }, { id: "nested" }],
    );
  } finally {
    await app.close();
    await database.close();
  }
});

Deno.test("F4 executing invocation grants remain fenced after attempt takeover and call closure", async () => {
  const { createTestDatabase } = await import("../testing/ominipg.ts");
  const { createEventStore, provisionCopilotzSchema } = await import(
    "../events/index.ts"
  );
  const { createSchemaCommandRunner, openDatabaseOwner, releaseDatabaseOwner } =
    await import("../engine/commands.ts");
  const { assertOwnerInvocationLive } = await import(
    "../engine/invocation-liveness.ts"
  );
  const { withOwnerCollectionInvocation } = await import("./invocation.ts");
  const { captureCollectionPolicy } = await import("./collection.ts");
  const { testCollectionAuthorizations } = await import(
    "../testing/collection-authorization.ts"
  );
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `invocation_fence_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const store = createEventStore({ session: db, schema });
  const run = createSchemaCommandRunner(db, schema);
  const source = await store.append({
    namespace: "space",
    type: "request",
    payload: {},
  }, ["processor"]);
  const deliveryId = source.deliveries[0].id;
  await store.claimDelivery({
    id: deliveryId,
    owner: "attempt",
    leaseMs: 60000,
  });
  let evaluations = 0;
  const record = defineCollection({
    name: "participant",
    schema: { type: "object" },
  });
  const registration = testCollectionAuthorizations(
    { participants: record },
    schema,
    ({ intent }) => {
      assertEquals(intent.invocation, {
        kind: "action",
        id: "threads.create",
        runId: "run",
      });
      evaluations++;
      return { collectionMutations: { participants: { create: {} } } };
    },
  ).get(record.name)!;
  const binding = {
    authority: testAuthority(schema),
    scope: { databaseSchema: schema, namespace: "space" },
    invocation: { kind: "action" as const, id: "threads.create", runId: "run" },
    signal: new AbortController().signal,
    check() {},
    assertCurrent: (
      read: {
        transaction: import("../events/session.ts").SqlExecutor;
        commandTime: string;
      },
    ) =>
      assertOwnerInvocationLive(read, {
        databaseSchema: schema,
        namespace: "space",
        eventId: source.event.id,
        writer: { deliveryId, leaseOwner: "attempt" },
      }),
    resolveSource: () =>
      Promise.reject(new Error("retained authority already present")),
  };
  let captured!: ReturnType<typeof captureCollectionPolicy>;
  const authorize = () =>
    withOwnerCollectionInvocation(binding, () => {
      captured = captureCollectionPolicy({
        registration,
        namespace: "space",
        databaseSchema: schema,
        method: "create",
        args: { input: { id: "new" } },
      });
      return run("invocation.authorize", {}, (_, command) =>
        captured.authorize(command, "mutation"));
    });
  try {
    await authorize();
    assertEquals(evaluations, 1);
    await assertRejects(
      () =>
        run(
          "invocation.expired",
          {},
          (_, command) => captured.authorize(command, "mutation"),
        ),
      Error,
      "authority has ended",
    );
    await run(
      "invocation.takeover",
      {},
      (_, command) =>
        command.transaction.query(
          `UPDATE "${schema}".event_deliveries SET lease_owner='successor' WHERE id=$1`,
          [deliveryId],
        ),
    );
    await assertRejects(authorize);
    assertEquals(evaluations, 1);
  } finally {
    releaseDatabaseOwner(owner);
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
