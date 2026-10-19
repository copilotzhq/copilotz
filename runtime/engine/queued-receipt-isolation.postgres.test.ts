import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { ActionError } from "../actions/errors.ts";
import {
  type CollectionCommandReceipt,
  collectionCommandReceipt,
  withCollectionCommandReceipt,
} from "../collections/command-receipt.ts";
import { defineCollection } from "../collections/definition.ts";

import { createCollectionRuntime } from "../collections/kernel.ts";
import {
  type CollectionInvocationAuthority,
  withOwnerCollectionInvocation,
} from "../collections/policy-invocation.ts";
import { validateCollectionPolicies } from "../collections/policy-registration.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { bounded, localPostgresUrl } from "../testing/effect-commit-proxy.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  captureOwnerCommandAuthorization,
  type OwnerCommandAuthorization,
  withOwnerCommandAuthorization,
} from "./command-authorization.ts";
import {
  type CommandContext,
  createSchemaCommandRunner,
  openDatabaseOwner,
  releaseDatabaseOwner,
} from "./commands.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const record = defineCollection({
  name: "queued_receipt_record",
  ownerPolicy: "required",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id", "name"],
  } as const,
});

function receipt(key: string, controller = new AbortController()) {
  const binding: CollectionCommandReceipt = {
    principal: `principal:${key}`,
    receiptReader: `reader:${key}`,
    receipt: {
      identity: { domain: "logical", key },
      intent: { key },
    },
    signal: controller.signal,
  };
  return { binding, controller };
}

async function fixture() {
  const db = await createTestDatabase({
    url: localPostgresUrl(url!),
    pgPoolMax: 4,
  });
  const schema = `queued_receipt_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const run = createSchemaCommandRunner(db, schema);
  const store = createEventStore({ session: db, schema });
  const source = (await store.append({
    namespace: "space",
    type: "fixture.source",
    payload: {},
  })).event;
  let allowed = true;
  let afterMutation: (() => void) | undefined;
  const seenReceipts: Array<CollectionCommandReceipt | undefined> = [];
  const checked: string[] = [];
  const guard: OwnerCommandAuthorization = ({ caller }, purpose) => {
    checked.push(`${caller.principal}:${purpose}`);
    if (!allowed) throw new Error("Current command authorization refused.");
  };
  const authority: CollectionInvocationAuthority = {
    scope: { databaseSchema: schema, namespace: "space" },
    invocation: { kind: "processor", id: "processor-b", runId: "attempt-b" },
    signal: new AbortController().signal,
    check() {},
    resolveSource: () =>
      Promise.resolve({ event: source, data: {}, ancestors: [] }),
  };
  const coordinator: EventCoordinator = {
    async commitMutation(input) {
      seenReceipts.push(collectionCommandReceipt());
      const committed = await store.commitMutation({ ...input, consumers: [] });
      afterMutation?.();
      return { ...committed, dispatch: { handles: [], failures: [] } };
    },
    flushCommitted: () => Promise.resolve({ handles: [], failures: [] }),
    append() {
      throw new Error("unused");
    },
    recover() {
      throw new Error("unused");
    },
  };
  const runtime = createCollectionRuntime({
    session: db,
    eventStore: store,
    coordinator,
    policies: validateCollectionPolicies({
      records: {
        authorize(_intent, context) {
          assertEquals(context.invocation, authority.invocation);
          if (!allowed) {
            throw new ActionError("Current Collection policy refused.", {
              code: "forbidden",
              status: 403,
            });
          }
        },
      },
    }, { records: record }),
  });
  runtime.bind(record);
  const adopt = async (command: CommandContext, id: string) => {
    await withOwnerCollectionInvocation(
      authority,
      () =>
        runtime.transaction({
          namespace: "space",
          operationKey: id,
          async execute({ collections }) {
            await collections.queued_receipt_record.create({ id, name: id });
          },
        }, command),
    );
    return { id };
  };
  return {
    db,
    schema,
    owner,
    run,
    guard,
    adopt,
    transact(id: string, binding: CollectionCommandReceipt) {
      return withCollectionCommandReceipt(
        binding,
        () =>
          withOwnerCollectionInvocation(authority, () =>
            runtime.transaction({
              namespace: "space",
              operationKey: id,
              async execute({ collections }) {
                await collections.queued_receipt_record.create({
                  id,
                  name: id,
                });
              },
            })),
      );
    },
    checked,
    seenReceipts,
    setAllowed(value: boolean) {
      allowed = value;
    },
    afterMutation(callback: () => void) {
      afterMutation = callback;
    },
    async rows() {
      return (await db.query(
        `SELECT id FROM "${schema}".nodes WHERE type=$1 ORDER BY id`,
        [record.name],
      )).rows;
    },
    async receipts() {
      return (await db.query(
        `SELECT key,principal,kind,intent,result,readers FROM "${schema}".owner_receipts ORDER BY key`,
      )).rows;
    },
    async close() {
      releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The principal getter marks synchronous admission, without sleeps or a queue API. */
async function behindEndedReceipt(
  f: Fixture,
  execute: (command: CommandContext) => Promise<{ id: string }>,
  beforeRelease?: () => void,
) {
  const a = receipt("a");
  const b = receipt("b");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const ended = new Error("Worker A ended before queued B ran.");
  const held = f.owner.register("fixture.held-a", {
    authorize() {},
    async execute() {
      entered.resolve();
      await release.promise;
      a.controller.abort(ended);
      return null;
    },
  });
  const first = withCollectionCommandReceipt(
    a.binding,
    () =>
      held({ principal: "principal:a", epoch: f.owner.epoch! }, { input: {} }),
  );
  let second: Promise<{ id: string }> | undefined;
  try {
    await bounded(entered.promise, "A holds the owner queue");
    second = withOwnerCommandAuthorization(
      f.guard,
      () =>
        f.run("fixture.b", {}, async (_input, command) => {
          assertEquals(a.controller.signal.aborted, true);
          assertEquals(command.caller.principal, b.binding.principal);
          return await execute(command);
        }, {
          ...b.binding,
          get principal() {
            admitted.resolve();
            return b.binding.principal;
          },
        }),
    );
    // Observe rejection immediately; negative controls intentionally reject B.
    void second.catch(() => undefined);
    await bounded(admitted.promise, "B is admitted behind A");
    beforeRelease?.();
    release.resolve();
    await bounded(first, "A ends");
    return await bounded(second, "B finishes under its own command");
  } finally {
    release.resolve();
    await first.catch(() => undefined);
    await second?.catch(() => undefined);
  }
}

Deno.test({
  name:
    "queued protected adoption does not inherit the ended first worker receipt and keeps B's durable identity",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      assertEquals(
        await behindEndedReceipt(f, (command) => f.adopt(command, "b")),
        { id: "b" },
      );
      assertEquals(f.seenReceipts, [undefined]);
      assertEquals(await f.rows(), [{ id: "b" }]);
      assertEquals(await f.receipts(), [{
        key: "b",
        principal: "principal:b",
        kind: "fixture.b",
        intent: { key: "b" },
        result: { id: "b" },
        readers: ["reader:b"],
      }]);
      assertEquals(f.checked, ["principal:b:mutation", "principal:b:result"]);
      const b = receipt("b").binding;
      f.setAllowed(false);
      await assertRejects(
        () =>
          withOwnerCommandAuthorization(
            f.guard,
            () => f.run("fixture.b", {}, () => ({ id: "unreachable" }), b),
          ),
        Error,
        "Current command authorization refused.",
      );
      f.setAllowed(true);
      const conflict = await assertRejects(() =>
        withOwnerCommandAuthorization(
          f.guard,
          () =>
            f.run("fixture.b", {}, () => ({ id: "unreachable" }), {
              ...b,
              receipt: { ...b.receipt, intent: { key: "other" } },
            }),
        )
      );
      assertEquals(
        (conflict as { code: string }).code,
        "owner_intent_conflict",
      );
      assertEquals(await f.rows(), [{ id: "b" }]);
      assertEquals((await f.receipts()).length, 1);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name: "queued B retains current authorization after unrelated A ends",
  ignore: !url,
  async fn() {
    const f = await fixture();
    let executed = false;
    try {
      await assertRejects(
        () =>
          behindEndedReceipt(f, (command) => {
            executed = true;
            return f.adopt(command, "refused");
          }, () => f.setAllowed(false)),
        Error,
        "Current command authorization refused.",
      );
      assertEquals(executed, false);
      assertEquals(f.checked, ["principal:b:mutation"]);
      assertEquals(await f.rows(), []);
      assertEquals(await f.receipts(), []);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "same-command joined Collection work retains its explicit receipt and cancellation rollback",
  ignore: !url,
  async fn() {
    const f = await fixture();
    try {
      const current = receipt("current");
      await f.run(
        "fixture.current",
        {},
        (_input, command) =>
          withCollectionCommandReceipt(current.binding, async () => {
            const joined = createSchemaCommandRunner(
              command.transaction,
              f.schema,
            );
            await joined("fixture.same-command", {}, async (_input, nested) => {
              assertStrictEquals(collectionCommandReceipt(), current.binding);
              await f.adopt(nested, "kept");
            });
          }),
      );
      assertStrictEquals(f.seenReceipts[0], current.binding);
      const cancelled = receipt("cancelled");
      const reason = new Error("Current command receipt cancelled.");
      f.afterMutation(() => cancelled.controller.abort(reason));
      const error = await assertRejects(() =>
        f.run(
          "fixture.cancelled",
          {},
          (_input, command) =>
            withCollectionCommandReceipt(
              cancelled.binding,
              () => f.adopt(command, "rolled-back"),
            ),
        )
      );
      assertStrictEquals(error, reason);
      assertStrictEquals(f.seenReceipts[1], cancelled.binding);
      assertEquals(await f.rows(), [{ id: "kept" }]);
      assertEquals(await f.receipts(), []);
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "afterCommit reentrant work has no old receipt or authorization and captures current authority",
  ignore: !url,
  async fn() {
    const f = await fixture();
    const old = receipt("publication-parent");
    const ended = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    try {
      await withCollectionCommandReceipt(
        old.binding,
        () =>
          withOwnerCommandAuthorization(
            f.guard,
            () =>
              f.run("fixture.publication", {}, (_input, command) => {
                command.afterCommit(async () => {
                  try {
                    await ended.promise;
                    assertEquals(old.controller.signal.aborted, true);
                    assertEquals(collectionCommandReceipt(), undefined);
                    assertEquals(captureOwnerCommandAuthorization(), undefined);
                    const fresh = receipt("publication-child").binding;
                    assertEquals(
                      await withOwnerCommandAuthorization(f.guard, () =>
                        f.run(
                          "fixture.published",
                          {},
                          (_input, current) => f.adopt(current, "published"),
                          fresh,
                        )),
                      { id: "published" },
                    );
                    f.setAllowed(false);
                    await assertRejects(
                      () =>
                        withOwnerCommandAuthorization(f.guard, () =>
                          f.run(
                            "fixture.published",
                            {},
                            () => ({ id: "never" }),
                            fresh,
                          )),
                      Error,
                      "Current command authorization refused.",
                    );
                    published.resolve();
                  } catch (error) {
                    published.reject(error);
                  }
                });
              }),
          ),
      );
      old.controller.abort(new Error("Publication parent ended."));
      ended.resolve();
      await bounded(
        published.promise,
        "publication reenters with current authority",
      );
      assertEquals(f.seenReceipts, [undefined]);
      assertEquals(await f.rows(), [{ id: "published" }]);
      assertEquals(
        (await f.receipts()).map(({ key, principal, readers }) => ({
          key,
          principal,
          readers,
        })),
        [{
          key: "publication-child",
          principal: "principal:publication-child",
          readers: ["reader:publication-child"],
        }],
      );
      assertEquals(f.checked, [
        "runtime:mutation",
        "runtime:result",
        "principal:publication-child:mutation",
        "principal:publication-child:result",
        "principal:publication-child:mutation",
      ]);
    } finally {
      ended.resolve();
      await f.close();
    }
  },
});

for (const cancelled of [false, true]) {
  Deno.test({
    name:
      `queued worker Collection transaction keeps its own captured receipt ${
        cancelled ? "cancellation" : "identity"
      }`,
    ignore: !url,
    async fn() {
      const f = await fixture();
      const a = receipt("captured-a");
      const b = receipt("captured-b");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const admitted = Promise.withResolvers<void>();
      const reason = new Error("Queued worker B was cancelled.");
      const held = f.owner.register("fixture.capture-holder", {
        authorize() {},
        async execute() {
          entered.resolve();
          await release.promise;
          a.controller.abort(new Error("Unrelated worker A ended."));
        },
      });
      const first = withCollectionCommandReceipt(
        a.binding,
        () =>
          held({ principal: "principal:a", epoch: f.owner.epoch! }, {
            input: {},
          }),
      );
      let second: ReturnType<typeof f.transact> | undefined;
      try {
        await bounded(entered.promise, "A holds captured worker transaction");
        second = f.transact("captured-b", {
          ...b.binding,
          get principal() {
            admitted.resolve();
            return b.binding.principal;
          },
        });
        void second.catch(() => undefined);
        await bounded(
          admitted.promise,
          "B captured its receipt before enqueue",
        );
        if (cancelled) b.controller.abort(reason);
        release.resolve();
        await bounded(first, "captured holder ends");
        if (cancelled) {
          assertStrictEquals(await assertRejects(() => second!), reason);
          assertEquals(await f.rows(), []);
          assertEquals(await f.receipts(), []);
        } else {
          await bounded(second, "captured receipt commits");
          assertEquals(await f.rows(), [{ id: "captured-b" }]);
          assertEquals(
            (await f.receipts()).map(({ key, principal, kind, readers }) => ({
              key,
              principal,
              kind,
              readers,
            })),
            [{
              key: "captured-b",
              principal: "principal:captured-b",
              kind: "collections.commit",
              readers: ["reader:captured-b"],
            }],
          );
        }
        assertEquals(f.seenReceipts, [undefined]);
      } finally {
        release.resolve();
        await first.catch(() => undefined);
        await second?.catch(() => undefined);
        await f.close();
      }
    },
  });
}
