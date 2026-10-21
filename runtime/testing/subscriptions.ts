import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import {
  activateDatabaseOwner,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "../engine/commands.ts";
import { createCollectionRuntime } from "../collections/kernel.ts";
import { defineCollection } from "../collections/definition.ts";
import {
  authorizationRefused,
  type OwnerAuthorization,
} from "../authorization/evaluator.ts";
import { createAuthorizationOwner } from "../authorization/owner.ts";
import {
  type AuthenticatedAuthority,
  credentialValidity,
} from "../authorization/authority.ts";
import { attachOwnerPush } from "../events/push.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import { createCollectionObserver } from "../subscriptions/owner.ts";
import type {
  CollectionSubscription,
  SubscriptionFrame,
} from "../subscriptions/types.ts";

export async function fixture(
  options: import("../subscriptions/owner.ts").SubscriptionLimits = {},
) {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `subs_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  let statements = 0;
  const statementsSql: { sql: string; params?: unknown[] }[] = [];
  const session = {
    query<TRow extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      statements++;
      statementsSql.push({ sql, params });
      return db.query<TRow>(sql, params);
    },
    transaction: <T>(
      work: (tx: import("../events/session.ts").SqlExecutor) => Promise<T>,
    ) =>
      db.transaction((tx) =>
        work({
          query(sql, params) {
            statements++;
            statementsSql.push({ sql, params });
            return tx.query(sql, params);
          },
        })
      ),
  };
  const owner = await openDatabaseOwner(session, schema);
  const run = createSchemaCommandRunner(session, schema);
  const store = createEventStore({ session, schema });
  const entry = defineCollection({
    name: "entry",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        visible: { type: "boolean" },
        title: { type: "string" },
      },
      required: ["id"],
    },
  });
  const member = defineCollection({
    name: "member",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        allowed: { type: "boolean" },
        restricted: { type: "boolean" },
      },
      required: ["id"],
    },
  });
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      return {
        ...await store.commitMutation({
          ...input,
          consumers: [],
          onCommitted() {},
        }),
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
  const runtime = createCollectionRuntime({
    session,
    eventStore: store,
    coordinator,
  });
  runtime.bind(entry);
  runtime.bind(member);
  const collections = runtime.withScope({ namespace: "main" });
  await collections.member.create({
    id: "key",
    allowed: true,
    restricted: false,
  });
  const authority: AuthenticatedAuthority = {
    version: 1,
    principal: { kind: "api-key", id: "key" },
    scope: {
      owner: "schema",
      databaseSchema: schema,
      tenant: "tenant",
      namespace: "main",
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
  let evaluations = 0;
  const intents: import("../authorization/evaluator.ts").AuthorizationIntent[] =
    [];
  const registration: OwnerAuthorization = {
    policies: {
      app: {
        revision: "1",
        sources: ["member"],
        async evaluate({ read, intent }) {
          evaluations++;
          intents.push(intent);
          const grant = await read.get("member", "key");
          if (!grant?.allowed) authorizationRefused();
          return {
            collections: {
              entry: grant.restricted ? { where: { visible: true } } : {},
            },
          };
        },
      },
    },
    collections: { entry: authority.policy },
    actions: {},
  };
  const authorization = createAuthorizationOwner({
    session,
    databaseSchema: schema,
    owner,
    registration,
    collections: { entry, member },
    operations: {} as OperationCatalog,
  });
  const notices = await attachOwnerPush(session, schema, (frame) => {
    if (frame.kind === "change" && frame.change.collectionChange) {
      authorization.notice({
        namespace: frame.change.namespace,
        collection: frame.change.collectionChange.collection,
        id: frame.change.collectionChange.id,
      });
    }
  });
  const observe = createCollectionObserver({
    session,
    schema,
    owner,
    authorization,
    collections: { entry, member },
    ...options,
  });
  await activateDatabaseOwner(owner, () => Promise.resolve());
  return {
    db,
    session,
    schema,
    owner,
    run,
    store,
    collections,
    authority,
    authorization,
    observe,
    definitions: { entry, member },
    registration,
    intents,
    statementsSql,
    counters: () => ({ statements, evaluations }),
    async close() {
      notices.close();
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
export function reader(subscription: CollectionSubscription) {
  const iterator = subscription.frames[Symbol.asyncIterator]();
  return {
    async next(): Promise<SubscriptionFrame> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Subscription frame timed out.")),
              5000,
            );
          }),
        ]);
        if (next.done) throw new Error("Unexpected subscription EOF.");
        return next.value;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
