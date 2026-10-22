import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testAuthority } from "../testing/authority.ts";
import { testCollectionAuthorizations } from "../testing/collection-authorization.ts";
import { withOwnerCollectionInvocation } from "../authorization/invocation.ts";
import { ActionError } from "../actions/errors.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
  type SqlSession,
} from "../events/index.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";
import { defineCollection } from "./definition.ts";
import { createCollectionRuntime } from "./kernel.ts";

Deno.test("primitive policy reads use one command; selectors retain the fresh disclosure gate", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 1,
  });
  let transactions = 0;
  const session: SqlSession = {
    query: db.query,
    transaction(fn) {
      transactions++;
      return db.transaction(fn);
    },
  };
  const schema = `perf_read_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(session, schema);
  const owner = await openDatabaseOwner(session, schema);
  const store = createEventStore({ session, schema });
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({ ...input, consumers: [] }),
        dispatch: { handles: [], failures: [] },
      };
    },
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  let allowed = true;
  let denyResult = false;
  const phases: string[] = [];
  const child = defineCollection({
    name: "child",
    ownerPolicy: "required",
    schema: { type: "object" },
  });
  const root = defineCollection({
    name: "root",
    schema: { type: "object" },
    queries: {
      nested: {
        async select({ read }) {
          assertEquals(await read.get("child", "missing"), null);
          // A named selector may yield to external I/O and a concurrent revocation.
          allowed = false;
          return [];
        },
      },
    },
  });
  const runtime = createCollectionRuntime({
    session,
    eventStore: store,
    coordinator,
    policies: testCollectionAuthorizations(
      { child, root },
      schema,
      ({ intent }) => {
        const phase = (intent.input as { phase: string }).phase;
        phases.push(`${intent.resource}:${phase}`);
        if (!allowed || denyResult && phase === "result") {
          throw new ActionError("read denied", {
            code: "forbidden",
            status: 403,
          });
        }
        return { collections: { child: {}, root: {} } };
      },
    ),
  });
  runtime.bind(child);
  runtime.bind(root);
  const invocation = {
    authority: testAuthority(schema, "space"),
    scope: { databaseSchema: schema, namespace: "space" },
    invocation: { kind: "processor" as const, id: "reader", runId: "attempt" },
    signal: new AbortController().signal,
    check() {},
    resolveSource(): Promise<never> {
      throw new Error("unused");
    },
  };
  const collections = runtime.withScope({ namespace: "space" });
  const read = () =>
    withOwnerCollectionInvocation(
      invocation,
      () => collections.child.get({ id: "missing" }),
    );
  try {
    transactions = 0;
    assertEquals(await read(), null);
    assertEquals(
      transactions,
      1,
      "a primitive read has one durable owner command",
    );
    assertEquals(phases, ["child:read", "child:result"]);
    denyResult = true;
    await assertRejects(read, ActionError, "Forbidden");
    denyResult = false;
    await assertRejects(
      () =>
        withOwnerCollectionInvocation(
          invocation,
          () => collections.root.queries.nested({}),
        ),
      ActionError,
      "Forbidden",
    );
    assertEquals(
      phases.at(-1),
      "child:result",
      "the selector rechecks its protected descendant",
    );
  } finally {
    await releaseDatabaseOwner(owner);
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});
