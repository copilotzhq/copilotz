import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { testAuthority } from "../testing/authority.ts";
import { withRetainedAuthority } from "./binding.ts";
import { defineDatabaseDirectoryRead } from "./directory-read.ts";
import type { ServerConstraints } from "./contracts.ts";

Deno.test("declared directory reads enforce both owner policies, freshness, projection, lifetime and committed audit", async () => {
  const db = await createOwnerTestDatabase();
  const routes = defineCollection({
    name: "route",
    schema: { type: "object" },
  });
  const directory = await createCopilotzApplication({
    database: db,
    databaseSchema: "directory",
    namespace: "directory",
    collections: { routes },
  });
  await directory.host.collections.routes.create({
    id: "route",
    tenant: "first",
    secret: "directory-secret",
  });
  let sourceAllowed: unknown = ["routing"];
  let destinationAllowed = true;
  let unavailable = false;
  let revokeOnRead = false;
  let commandAttempt: (() => Promise<unknown>) | undefined;
  let retained: (() => Promise<unknown>) | undefined;
  const declaration = defineDatabaseDirectoryRead({
    revision: "1",
    databaseSchema: "directory",
    namespace: "directory",
    collection: routes,
    actions: ["lookup"],
    fields: ["tenant"],
    maxBytes: 64,
    async authorize({ authority, id, record }) {
      if (unavailable) throw new Error("Directory unavailable");
      await commandAttempt?.();
      if (revokeOnRead) sourceAllowed = [];
      assertEquals(record?.secret, "directory-secret");
      return destinationAllowed && authority.scope.tenant === "fixture" &&
        authority.principal.id === "reader" && id === "route";
    },
  });
  assertThrows(
    () =>
      defineDatabaseDirectoryRead({ ...declaration, fields: [], maxBytes: 0 }),
    TypeError,
  );
  const app = await createCopilotzApplication({
    database: db,
    namespace: "space",
    actions: {
      lookup: defineAction({
        id: "directory.lookup",
        async execute(
          input: { alias?: string; id?: string },
          ctx: ActionContext,
        ) {
          assertEquals(Object.keys(ctx.directory), ["get"]);
          retained = () => ctx.directory.get("routing", "route");
          return await ctx.directory.get(
            input.alias ?? "routing",
            input.id ?? "route",
          );
        },
      }),
      undeclared: defineAction({
        id: "directory.undeclared",
        execute: (_input, ctx: ActionContext) =>
          ctx.directory.get("routing", "route"),
      }),
      captured: defineAction({
        id: "directory.captured",
        execute: () => directory.host.collections.routes.get({ id: "route" }),
      }),
    },
    authorization: {
      directoryReads: { routing: declaration },
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate({ intent, authority }) {
            if (intent.kind === "directory") {
              assertEquals(intent.invocation?.id, "directory.lookup");
              assertEquals(authority.scope.databaseSchema, "public");
            }
            return {
              actions: { lookup: {}, undeclared: {}, captured: {} },
              directoryReads: sourceAllowed,
            } as ServerConstraints;
          },
        },
      },
      actions: Object.fromEntries(
        ["lookup", "undeclared", "captured"].map((
          name,
        ) => [name, { id: "fixture", revision: "1" }]),
      ),
      collections: {},
    },
  });
  const call = (
    action = "lookup",
    input = {},
    principal = "reader",
    tenant = "fixture",
  ) => {
    const authority = testAuthority("public", "space", principal);
    return withRetainedAuthority(
      { ...authority, scope: { ...authority.scope, tenant } },
      new AbortController().signal,
      () => app.host.actions[action](input),
    );
  };
  const denied = async (
    action = "lookup",
    input = {},
    principal = "reader",
    tenant = "fixture",
  ) => {
    const error = await assertRejects(() =>
      call(action, input, principal, tenant)
    );
    assertEquals((error as { code: string }).code, "forbidden");
  };
  try {
    assertEquals(await call(), { tenant: "first" });
    assertThrows(() => retained!());
    await directory.host.collections.routes.update({
      id: "route",
      set: { tenant: "second" },
    });
    assertEquals(await call(), { tenant: "second" });
    commandAttempt = () => app.host.actions.lookup({});
    await assertRejects(() => call(), Error, "cannot submit commands");
    commandAttempt = undefined;
    await denied("undeclared");
    await denied("captured");
    await denied("lookup", { alias: "unknown" });
    await denied("lookup", { alias: "constructor" });
    await denied("lookup", {}, "other");
    await denied("lookup", {}, "reader", "other");
    destinationAllowed = false;
    await denied();
    destinationAllowed = true;
    sourceAllowed = [];
    await denied();
    sourceAllowed = "routing";
    await denied();
    sourceAllowed = ["routing"];
    revokeOnRead = true;
    await denied();
    revokeOnRead = false;
    sourceAllowed = ["routing"];
    await directory.host.collections.routes.update({
      id: "route",
      set: { tenant: "x".repeat(100) },
    });
    await denied();
    await assertRejects(() => app.host.actions.lookup({}));
    const audits = await db.query<
      {
        intent: {
          principal: { id: string };
          operationId: string;
          invocation: { id: string };
          destination: { databaseSchema: string };
          resultDigest: string;
        };
      }
    >("SELECT intent FROM public.owner_receipts WHERE kind='authorization.directory'");
    assertEquals(audits.rows.length, 2);
    assert(
      audits.rows.every(({ intent }) =>
        intent.principal.id === "reader" && intent.operationId &&
        intent.invocation.id === "directory.lookup" &&
        intent.destination.databaseSchema === "directory"
      ),
    );
    assert(
      audits.rows[0].intent.resultDigest !== audits.rows[1].intent.resultDigest,
    );
    assert(!JSON.stringify(audits.rows).includes("directory-secret"));
    await directory.host.collections.routes.update({
      id: "route",
      set: { tenant: "short" },
    });
    await db.query(
      `CREATE FUNCTION public.refuse_directory_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='authorization.directory' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`,
    );
    await db.query(
      `CREATE TRIGGER refuse_directory_audit BEFORE INSERT ON public.owner_receipts FOR EACH ROW EXECUTE FUNCTION public.refuse_directory_audit()`,
    );
    await assertRejects(() => call(), Error, "audit unavailable");
    await db.query(`DROP FUNCTION public.refuse_directory_audit() CASCADE`);
    unavailable = true;
    await assertRejects(() => call());
  } finally {
    await app.close();
    await directory.close();
    await db.close();
  }
});
