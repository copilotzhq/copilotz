import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { testAuthority } from "../testing/authority.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { withRetainedAuthority } from "./binding.ts";
import { defineDatabaseDirectoryCommand } from "./directory-command.ts";
import type { DirectoryCollections } from "./directory-collections.ts";
import type { SubscriptionFrame } from "../subscriptions/types.ts";

async function fixture() {
  const db = await createOwnerTestDatabase();
  let sourceAllowed = true, destinationAllowed = true, collectionAllowed = true;
  let executions = 0;
  let escaped: DirectoryCollections | undefined;
  const policies: string[] = [], processed: string[] = [];
  const loginIndex = defineCollection({
    name: "native_login_index",
    schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        members: { type: "array", items: { type: "string" } },
      },
      required: ["subject", "members"],
    },
    indexes: [{ fields: "subject", unique: true }],
    commands: {
      addMembership: {
        event: "native_login_index.membershipAdded",
        mutate({ current, input }) {
          const member = (input as { member: string }).member;
          return {
            set: {
              members: [...new Set([...(current.members as string[]), member])],
            },
          };
        },
      },
    },
  });
  const tenantRoute = defineCollection({
    name: "native_tenant_route",
    schema: { type: "object", properties: { active: { type: "boolean" } } },
    indexes: ["active"],
  });
  const unrelated = defineCollection({
    name: "native_unrelated",
    schema: { type: "object" },
  });
  const directory = await createCopilotzApplication({
    database: db,
    databaseSchema: "directory",
    namespace: "directory",
    collections: { loginIndex, tenantRoute, unrelated },
    processors: {
      publication: defineProcessor({
        id: "directory.publication",
        on: [{ eventType: "native_login_index.membershipAdded" }],
        handle(event) {
          assert(event.durable);
          processed.push(event.id);
        },
      }),
    },
    authorization: {
      policies: {
        destination: {
          revision: "1",
          sources: ["loginIndex"],
          evaluate({ authority, intent, directory }) {
            if (directory) {
              assertEquals(authority.scope.databaseSchema, "public");
              assertEquals(authority.scope.namespace, "space");
              assertEquals(directory, {
                command: "publishMembership",
                databaseSchema: "directory",
                namespace: "directory",
              });
              assertEquals(intent.invocation?.id, "directory.login");
              policies.push(`${intent.resource}:${intent.operation}`);
              if (!collectionAllowed) return {};
            }
            return {
              collections: { loginIndex: {}, tenantRoute: {} },
              collectionMutations: {
                loginIndex: { create: {}, commands: { addMembership: {} } },
                tenantRoute: { create: {} },
              },
            };
          },
        },
      },
      actions: {},
      collections: Object.fromEntries(
        ["loginIndex", "tenantRoute", "unrelated"].map((
          name,
        ) => [name, { id: "destination", revision: "1" }]),
      ),
    },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  const declaration = defineDatabaseDirectoryCommand({
    databaseSchema: "directory",
    namespace: "directory",
    command: "publishMembership",
    revision: "1",
    actions: ["login"],
    collections: {
      loginIndex: ["get", "create", "addMembership"],
      tenantRoute: ["create"],
    },
    authorize: ({ authority }) =>
      destinationAllowed && authority.scope.tenant === "fixture",
    async execute({ collections, input, transaction }) {
      executions++;
      escaped = collections;
      const { id, mode } = input as { id: string; mode?: string };
      const source = await transaction.query(
        "SELECT id FROM public.nodes WHERE namespace='space' AND type='native_account' AND id=$1",
        [id],
      );
      assertEquals(source.rows.length, 1);
      assertEquals(await collections.loginIndex.get({ id }), null);
      await collections.loginIndex.create({ id, subject: id, members: [] });
      await collections.loginIndex.commands.addMembership({ id, member: id });
      await collections.tenantRoute.create({
        id: `route:${id}`,
        active: true,
        databaseSchema: "public",
      });
      if (mode === "caught") {
        try {
          await collections.unrelated.create({ id });
        } catch { /* A caught refusal must still poison the transaction. */ }
      }
      if (mode === "unrelated") await collections.unrelated.create({ id });
      if (mode === "method") {
        await collections.loginIndex.commands.erase({ id });
      }
      if (mode === "failure") throw new Error("Injected directory failure");
      return { id };
    },
  });
  const app = await createCopilotzApplication({
    database: db,
    namespace: "space",
    adapters: { secrets: { default: await testSecretAdapter() } },
    collections: {
      accounts: defineCollection({
        name: "native_account",
        schema: { type: "object" },
      }),
    },
    actions: {
      login: defineAction({
        id: "directory.login",
        async execute(
          input: { id: string; mode?: string },
          ctx: ActionContext,
        ) {
          await ctx.transaction(async (tx) => {
            await tx.collections.accounts.create({ id: input.id });
            await tx.directory.command("publish", input, {
              operationKey: "membership",
            });
            if (input.mode === "replay") {
              await tx.directory.command("publish", input, {
                operationKey: "membership",
              });
            }
            await tx.sessions.create({
              principal: input.mode === "credential" ? "admin" : input.id,
              maxAge: 3600,
            });
            if (input.mode === "source-failure") {
              throw new Error("Injected source failure");
            }
          });
          if (input.mode === "replay-denied") {
            collectionAllowed = false;
            await ctx.directory.command("publish", input, {
              operationKey: "membership",
            });
          }
          return { id: input.id };
        },
      }),
    },
    authorization: {
      directoryCommands: { publish: declaration },
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate({ authority, intent }) {
            if (
              intent.kind === "session" &&
              authority.principal.id === "late-destination"
            ) collectionAllowed = false;
            if (
              intent.kind === "session" &&
              authority.principal.id === "late-source"
            ) sourceAllowed = false;
            return {
              actions: { login: {} },
              directoryCommands: sourceAllowed ? ["publish"] : [],
              collections: { accounts: {} },
              collectionMutations: { accounts: { create: {} } },
              sessions: {
                create: { principal: authority.principal.id, maxAge: 3600 },
              },
            };
          },
        },
      },
      actions: { login: { id: "fixture", revision: "1" } },
      collections: { accounts: { id: "fixture", revision: "1" } },
    },
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  const authority = testAuthority("directory", "directory");
  const subscription = await directory.host.collections.loginIndex.observe({}, {
    authority: { ...authority, policy: { id: "destination", revision: "1" } },
  });
  const frames: SubscriptionFrame[] = [];
  const observing = (async () => {
    for await (const frame of subscription.frames) frames.push(frame);
  })();
  const call = (id: string, mode?: string) => {
    const authority = testAuthority("public", "space", id);
    return withRetainedAuthority(
      {
        ...authority,
        scope: {
          ...authority.scope,
          bindings: { "@credential-proof": "a".repeat(64) },
        },
      },
      new AbortController().signal,
      () => app.host.actions.login({ id, ...(mode ? { mode } : {}) }),
    );
  };
  const counts = async () => {
    const rows = await db.query<
      {
        accounts: number;
        directory: number;
        effects: number;
        events: number;
        receipts: number;
      }
    >(`SELECT
      (SELECT count(*)::int FROM public.nodes WHERE type='native_account') accounts,
      (SELECT count(*)::int FROM directory.nodes WHERE type LIKE 'native_%') directory,
      (SELECT count(*)::int FROM public.authorization_effects WHERE method='session.create') effects,
      (SELECT count(*)::int FROM directory.events WHERE type LIKE 'native_%') events,
      (SELECT count(*)::int FROM public.owner_receipts WHERE kind='directory.command') receipts`);
    return rows.rows[0];
  };
  return {
    db,
    directory,
    call,
    counts,
    frames,
    policies,
    processed,
    executions: () => executions,
    attachAmbiguous: () =>
      createCopilotzApplication({
        database: db,
        databaseSchema: "directory",
        namespace: "directory",
        collections: { loginIndex, tenantRoute },
      }),
    escaped: () => escaped!,
    source: (value: boolean) => sourceAllowed = value,
    destination: (value: boolean) => destinationAllowed = value,
    collection: (value: boolean) => collectionAllowed = value,
    async close() {
      subscription.detach();
      await observing;
      await app.close();
      await directory.close();
      await db.close();
    },
  };
}

Deno.test("native directory commands atomically publish first-login Collections, indexes and session; replay publishes once", async () => {
  const f = await fixture();
  try {
    assertEquals(await f.call("account", "replay"), { id: "account" });
    assertEquals(await f.counts(), {
      accounts: 1,
      directory: 2,
      effects: 1,
      events: 3,
      receipts: 1,
    });
    assertEquals(f.executions(), 1);
    assert(f.policies.includes("loginIndex:command"));
    const rows = await f.directory.host.collections.loginIndex.list({
      where: { subject: "account" },
    });
    assertEquals(rows.length, 1);
    assertEquals(rows[0].members, ["account"]);
    for (
      let i = 0;
      i < 300 &&
      (!f.processed.length || !f.frames.some((frame) =>
        frame.t === "batch" &&
        frame.changes.some((c) =>
          (c.record?.members as string[])?.includes("account")
        )
      ));
      i++
    ) await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(f.processed.length, 1);
    const changes = f.frames.flatMap((frame) =>
      frame.t === "batch" ? frame.changes : []
    );
    assertEquals(
      changes.filter((c) =>
        (c.record?.members as string[])?.includes("account")
      ).length,
      1,
    );
    await assertRejects(
      () =>
        f.escaped().loginIndex.create({
          id: "escaped",
          subject: "escaped",
          members: [],
        }),
      Error,
      "lifetime ended",
    );
    assertEquals(await f.counts(), {
      accounts: 1,
      directory: 2,
      effects: 1,
      events: 3,
      receipts: 1,
    });
  } finally {
    await f.close();
  }
});

Deno.test("native directory source/destination/Collection refusals and failures roll back both schemas without publication", async () => {
  const f = await fixture();
  try {
    for (
      const mode of [
        "source",
        "destination",
        "collection",
        "unrelated",
        "method",
        "failure",
        "source-failure",
        "caught",
        "credential",
        "late-destination",
        "late-source",
      ]
    ) {
      f.source(mode !== "source");
      f.destination(mode !== "destination");
      f.collection(mode !== "collection");
      const error = await assertRejects(() => f.call(mode, mode));
      if (!["failure", "source-failure"].includes(mode)) {
        assertEquals((error as { code: string }).code, "forbidden", mode);
      } else {assert(
          (error as Error).message.includes("Injected"),
          String(error),
        );}
      assertEquals(await f.counts(), {
        accounts: 0,
        directory: 0,
        effects: 0,
        events: 0,
        receipts: 0,
      }, mode);
      assertEquals(f.processed, []);
      assertEquals(f.frames.filter((frame) => frame.t === "batch"), []);
    }
    f.source(true);
    f.destination(true);
    f.collection(true);
    await f.call("after-refusals");
    assertEquals((await f.counts()).directory, 2);
  } finally {
    await f.close();
  }
});

Deno.test("native directory receipt replay rechecks current destination Collection policy", async () => {
  const f = await fixture();
  try {
    const error = await assertRejects(() => f.call("account", "replay-denied"));
    assertEquals((error as { code: string }).code, "forbidden");
    assertEquals(f.executions(), 1);
    assertEquals(await f.counts(), {
      accounts: 1,
      directory: 2,
      effects: 1,
      events: 3,
      receipts: 1,
    });
  } finally {
    await f.close();
  }
});

Deno.test("native directory refuses ambiguous attached destination compositions and releases closed registrations", async () => {
  const f = await fixture();
  try {
    const other = await f.attachAmbiguous();
    try {
      const error = await assertRejects(() => f.call("ambiguous"));
      assertEquals((error as { code: string }).code, "forbidden");
      assertEquals((await f.counts()).directory, 0);
    } finally {
      await other.close();
    }
    await f.call("unambiguous");
    assertEquals((await f.counts()).directory, 2);
  } finally {
    await f.close();
  }
});
