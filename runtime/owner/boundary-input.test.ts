import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommandBoundaryOptions,
  type OwnerCommandHandler,
  type OwnerInputCommand,
  type OwnerJson,
} from "./boundary.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const caller = (): OwnerCaller => ({
  principal: { kind: "worker" as const, workerId: "worker-a" },
  ownerEpoch: 1,
  authenticated: true,
});
const command = (
  key: string,
  input: OwnerJson = { id: key },
  kind = "put",
): OwnerInputCommand => ({ kind, domain: "logical", key, input });
const errorCode = (code: string) => (error: unknown): boolean =>
  !!error && typeof error === "object" &&
  (error as { code?: unknown }).code === code;

async function fixture(
  run: (db: TestDatabase) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  try {
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    await provisionOwnerCommandSchema(db, "public");
    await run(db);
  } finally {
    await db.close();
  }
}
const put: OwnerCommandHandler = async (intent, context) => {
  const id = (intent as { id: string }).id;
  await context.tx.query(
    `INSERT INTO public.nodes(id,namespace,type,name,data)
    VALUES($1,'test','note',$1,'{"writes":1}')
    ON CONFLICT(id) DO UPDATE
    SET data=jsonb_build_object('writes',(nodes.data->>'writes')::int+1)`,
    [id],
  );
  return { recordIds: [id], eventIds: [] };
};
function options(
  session: SqlSession,
  extra: Partial<OwnerCommandBoundaryOptions> = {},
): OwnerCommandBoundaryOptions {
  return {
    session,
    schema: "public",
    ownerId: "tenant-a",
    holderId: "holder-a",
    handlers: { put },
    inputDefinitions: {
      put: {
        normalize(input) {
          return { intent: { id: (input as { id: string }).id }, value: input };
        },
      },
    },
    authorize(_tx, who) {
      if (who.authenticated !== true) throw new Error("not authorized");
    },
    authenticateReceipt(_tx, who) {
      if (who.authenticated !== true) throw new Error("not authenticated");
    },
    ...extra,
  };
}
async function nodeIds(db: SqlExecutor): Promise<string[]> {
  return (await db.query<{ id: string }>(
    "SELECT id FROM public.nodes ORDER BY id",
  )).rows.map((row) => row.id);
}
async function receiptKeys(db: SqlExecutor): Promise<string[]> {
  return (await db.query<{ key: string }>(
    "SELECT key FROM public.owner_receipts ORDER BY key",
  )).rows.map((row) => row.key);
}

// These are real SQL-session/savepoint tests over PGlite, not distributed crash proof.
test("input commands isolate source, normalized, authority, handler, and callback objects", async () => {
  await fixture(async (db) => {
    const source = { id: "original", secret: { text: "raw-private-marker" } };
    const normalized = {
      intent: { id: "original", version: 1 },
      value: { payload: { text: "normalized-private-marker" } },
    };
    const expectedIntent = { id: "original", version: 1 };
    const expectedValue = { payload: { text: "normalized-private-marker" } };
    const published = deferred();
    let normalizerInput: OwnerJson | undefined;
    let handlerInput: OwnerJson | undefined;
    let handlerIntent: OwnerJson | undefined;
    const safeResult = { recordIds: ["original"], eventIds: [] as string[] };
    const owner = createOwnerCommandBoundary(options(db, {
      inputDefinitions: {
        put: {
          normalize(input) {
            normalizerInput = input;
            assert.deepEqual(input, {
              id: "original",
              secret: { text: "raw-private-marker" },
            });
            assert.notEqual(input, source);
            return normalized;
          },
        },
      },
      authorize(_tx, who, request, _time, input) {
        assert.deepEqual(request.intent, expectedIntent);
        assert.deepEqual(input, expectedValue);
        assert.notEqual(input, normalized.value);
        Object.assign(who.principal, { workerId: "authority-poison" });
        Object.assign(request, { key: "authority-poison" });
        Object.assign(request.intent as object, { id: "authority-poison" });
        (input as typeof expectedValue).payload.text = "authority-poison";
        normalized.intent.id = "normalizer-output-poison";
        normalized.value.payload.text = "normalizer-output-poison";
        (normalizerInput as typeof source).secret.text =
          "normalizer-input-poison";
      },
      handlers: {
        async put(intent, context) {
          handlerInput = context.input;
          handlerIntent = intent;
          assert.deepEqual(intent, expectedIntent);
          assert.deepEqual(context.input, expectedValue);
          assert.equal(context.command.key, "original");
          assert.equal(
            context.caller.principal.kind === "worker"
              ? context.caller.principal.workerId
              : undefined,
            "worker-a",
          );
          await put(intent, context);
          Object.assign(intent as object, { id: "handler-poison" });
          (context.input as typeof expectedValue).payload.text =
            "handler-poison";
          context.afterCommit(() => {
            safeResult.recordIds[0] = "callback-poison";
            Object.assign(handlerIntent as object, { id: "callback-poison" });
            (handlerInput as typeof expectedValue).payload.text =
              "callback-poison";
            published.resolve();
          });
          return safeResult;
        },
      },
    }));
    await owner.acquire(0);
    const submitted = command("original", source);
    const pending = owner.executeInput(caller(), submitted);
    source.id = "source-poison";
    source.secret.text = "source-poison";
    Object.assign(submitted, { key: "source-poison", kind: "source-poison" });
    const outcome = await pending;
    await published.promise;
    assert.deepEqual(outcome, {
      status: "committed",
      result: { recordIds: ["original"], eventIds: [] },
    });
    assert.deepEqual(await nodeIds(db), ["original"]);
    const receipt = await owner.readReceipt(caller(), {
      domain: "logical",
      key: "original",
    });
    assert.deepEqual(receipt, {
      kind: "put",
      intent: expectedIntent,
      result: { recordIds: ["original"], eventIds: [] },
    });
    const raw = (await db.query<{ serialized: string }>(
      "SELECT to_jsonb(r)::text AS serialized FROM public.owner_receipts r",
    )).rows[0].serialized;
    for (
      const privateValue of [
        "raw-private-marker",
        "normalized-private-marker",
        "payload",
        "secret",
        "poison",
      ]
    ) {
      assert.equal(raw.includes(privateValue), false);
      assert.equal(JSON.stringify(receipt).includes(privateValue), false);
    }
    Object.assign(receipt!.intent as object, { id: "read-copy-poison" });
    (receipt!.result as { recordIds: string[] }).recordIds[0] =
      "read-copy-poison";
    assert.deepEqual(
      await owner.readReceipt(caller(), { domain: "logical", key: "original" }),
      {
        kind: "put",
        intent: expectedIntent,
        result: { recordIds: ["original"], eventIds: [] },
      },
    );
  });
});

test("duplicates normalize and reauthorize actual submitted payload before replay", async () => {
  await fixture(async (db) => {
    const normalized: string[] = [];
    const authorized: string[] = [];
    let handlers = 0;
    const owner = createOwnerCommandBoundary(options(db, {
      inputDefinitions: {
        put: {
          normalize(input) {
            const request = input as {
              id: string;
              token: string;
              version: number;
              deployment: string;
            };
            normalized.push(request.token);
            return {
              intent: { id: request.id, version: request.version },
              value: {
                permission: request.token,
                deployment: request.deployment,
              },
            };
          },
        },
      },
      authorize(_tx, _who, _request, _time, input) {
        const permission = (input as { permission: string }).permission;
        authorized.push(permission);
        if (permission === "revoked") {
          throw new Error("current authority revoked");
        }
      },
      handlers: {
        async put(intent, context) {
          handlers++;
          return await put(intent, context);
        },
      },
    }));
    await owner.acquire(0);
    const request = (token: string, version = 1, deployment = "build-a") =>
      command("same", { id: "same", token, version, deployment });
    assert.equal(
      (await owner.executeInput(caller(), request("first"))).status,
      "committed",
    );
    await assert.rejects(
      owner.executeInput(caller(), request("revoked")),
      /current authority revoked/,
    );
    const replay = await owner.executeInput(
      caller(),
      request("renewed", 1, "build-b"),
    );
    assert.equal(replay.status, "duplicate");
    assert.deepEqual(replay.result, { recordIds: ["same"], eventIds: [] });
    await assert.rejects(
      owner.executeInput(caller(), request("new-semantics", 2)),
      errorCode("owner_intent_conflict"),
    );
    assert.deepEqual(normalized, [
      "first",
      "revoked",
      "renewed",
      "new-semantics",
    ]);
    assert.deepEqual(authorized, normalized);
    assert.equal(handlers, 1);
    assert.deepEqual(await receiptKeys(db), ["same"]);
    assert.deepEqual(
      (await db.query("SELECT data FROM public.nodes WHERE id='same'")).rows,
      [{ data: { writes: 1 } }],
    );
  });
});

test("normalization runs inside independent savepoints before authorization and receipt lookup", async () => {
  await fixture(async (db) => {
    let inSavepoint = false;
    const events: string[] = [];
    const session: SqlSession = {
      query: db.query,
      transaction(operation) {
        return db.transaction((tx) =>
          operation({
            async query<
              TRow extends Record<string, unknown> = Record<string, unknown>,
            >(sql: string, params?: unknown[]) {
              const result = await tx.query<TRow>(sql, params);
              if (/^SAVEPOINT /i.test(sql)) inSavepoint = true;
              if (/^RELEASE SAVEPOINT /i.test(sql)) inSavepoint = false;
              if (/^ROLLBACK TO SAVEPOINT /i.test(sql)) events.push("rollback");
              if (/SELECT kind,intent,result FROM /i.test(sql)) {
                events.push("lookup");
              }
              return result;
            },
          })
        );
      },
    };
    const owner = createOwnerCommandBoundary(options(session, {
      inputDefinitions: {
        put: {
          normalize(input) {
            assert.equal(inSavepoint, true);
            const id = (input as { id: string }).id;
            events.push(`normalize:${id}`);
            if (id === "sync-error") {
              throw new Error("sync normalization rejected");
            }
            if (id === "async-error") {
              return Promise.reject(new Error("async normalization rejected"));
            }
            return { intent: { id }, value: input };
          },
        },
      },
      authorize(_tx, _who, request) {
        events.push(`authorize:${request.key}`);
      },
    }));
    await owner.acquire(0);
    const outcomes = await Promise.allSettled(
      ["first", "sync-error", "async-error", "last"].map((key) =>
        owner.executeInput(caller(), command(key))
      ),
    );
    assert.deepEqual(outcomes.map((outcome) => outcome.status), [
      "fulfilled",
      "rejected",
      "rejected",
      "fulfilled",
    ]);
    assert.deepEqual(events, [
      "normalize:first",
      "authorize:first",
      "lookup",
      "normalize:sync-error",
      "rollback",
      "normalize:async-error",
      "rollback",
      "normalize:last",
      "authorize:last",
      "lookup",
    ]);
    assert.deepEqual(await nodeIds(db), ["first", "last"]);
    assert.deepEqual(await receiptKeys(db), ["first", "last"]);
    assert.equal(owner.state, "acquired");
    assert.equal(
      (await owner.executeInput(caller(), command("after-error"))).status,
      "committed",
    );
  });
});

test("aborting active async normalization or queued input skips authorization and effects", async () => {
  await fixture(async (db) => {
    const entered = deferred();
    const release = deferred();
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const seen: string[] = [];
    let authorized = 0;
    let handled = 0;
    let published = 0;
    const owner = createOwnerCommandBoundary(options(db, {
      maxGroup: 1,
      inputDefinitions: {
        put: {
          async normalize(input) {
            const id = (input as { id: string }).id;
            seen.push(id);
            if (id === "active") {
              entered.resolve();
              await release.promise;
            }
            return { intent: { id }, value: input };
          },
        },
      },
      authorize() {
        authorized++;
      },
      handlers: {
        async put(intent, context) {
          handled++;
          context.afterCommit(() => {
            published++;
          });
          return await put(intent, context);
        },
      },
    }));
    await owner.acquire(0);
    const active = owner.executeInput(caller(), command("active"), {
      signal: activeAbort.signal,
    });
    const queued = owner.executeInput(caller(), command("queued"), {
      signal: queuedAbort.signal,
    });
    const results = Promise.allSettled([active, queued]);
    await entered.promise;
    activeAbort.abort(new Error("normalization cancelled"));
    queuedAbort.abort(new Error("queued input cancelled"));
    release.resolve();
    const outcomes = await results;
    for (const outcome of outcomes) assert.equal(outcome.status, "rejected");
    assert.deepEqual(seen, ["active"]);
    assert.equal(authorized, 0);
    assert.equal(handled, 0);
    assert.equal(published, 0);
    assert.deepEqual(await nodeIds(db), []);
    assert.deepEqual(await receiptKeys(db), []);
    const preAborted = new AbortController();
    preAborted.abort(new Error("already cancelled"));
    await assert.rejects(
      owner.executeInput(caller(), command("pre-aborted"), {
        signal: preAborted.signal,
      }),
      /already cancelled/,
    );
    assert.deepEqual(seen, ["active"]);
    assert.equal(
      (await owner.executeInput(caller(), command("recovered"))).status,
      "committed",
    );
  });
});

test("authorization and handler failures roll back input command writes and callbacks", async () => {
  await fixture(async (db) => {
    const published: string[] = [];
    const finished = deferred();
    const owner = createOwnerCommandBoundary(options(db, {
      async authorize(tx, _who, request) {
        if (request.key !== "deny") return;
        await tx.query(
          "INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('deny','test','note','deny','{}')",
        );
        throw new Error("authorization denied");
      },
      handlers: {
        async put(intent, context) {
          const result = await put(intent, context);
          context.afterCommit(() => {
            published.push(context.command.key);
            if (context.command.key === "last") finished.resolve();
          });
          if (context.command.key === "fail") throw new Error("handler failed");
          return result;
        },
      },
    }));
    await owner.acquire(0);
    const outcomes = await Promise.allSettled(
      ["first", "deny", "fail", "last"].map((key) =>
        owner.executeInput(caller(), command(key))
      ),
    );
    assert.deepEqual(outcomes.map((outcome) => outcome.status), [
      "fulfilled",
      "rejected",
      "rejected",
      "fulfilled",
    ]);
    await finished.promise;
    assert.deepEqual(published, ["first", "last"]);
    assert.deepEqual(await nodeIds(db), ["first", "last"]);
    assert.deepEqual(await receiptKeys(db), ["first", "last"]);
  });
});

test("input and both normalized outputs are independently JSON-bounded without admission leaks", async () => {
  await fixture(async (db) => {
    let normalizations = 0;
    let authorizations = 0;
    const large = "é".repeat(524_289);
    const owner = createOwnerCommandBoundary(options(db, {
      maxQueue: 1,
      inputDefinitions: {
        put: {
          normalize(input): { intent: OwnerJson; value: OwnerJson } {
            normalizations++;
            const id = (input as { id: string }).id;
            if (id === "large-intent") {
              return { intent: { id, large }, value: null };
            }
            if (id === "large-value") {
              return { intent: { id }, value: { large } };
            }
            if (id === "invalid-intent") {
              return {
                intent: { id: undefined } as unknown as OwnerJson,
                value: null,
              };
            }
            if (id === "invalid-value") {
              return {
                intent: { id },
                value: { hidden: undefined } as unknown as OwnerJson,
              };
            }
            return { intent: { id }, value: input };
          },
        },
      },
      authorize() {
        authorizations++;
      },
    }));
    await owner.acquire(0);
    let getterCalls = 0;
    const accessorInput = {
      get id() {
        getterCalls++;
        return "getter";
      },
    };
    const cycle: { next?: unknown } = {};
    cycle.next = cycle;
    for (
      const input of [
        { id: "large-input", large },
        accessorInput,
        cycle as OwnerJson,
        { id: undefined } as unknown as OwnerJson,
      ]
    ) {
      await assert.rejects(
        owner.executeInput(caller(), command("rejected-input", input)),
        errorCode("owner_command_invalid"),
      );
    }
    assert.equal(getterCalls, 0);
    assert.equal(normalizations, 0);
    for (
      const key of [
        "large-intent",
        "large-value",
        "invalid-intent",
        "invalid-value",
      ]
    ) {
      await assert.rejects(
        owner.executeInput(caller(), command(key)),
        errorCode("owner_command_invalid"),
      );
    }
    assert.equal(normalizations, 4);
    assert.equal(authorizations, 0);
    assert.deepEqual(await receiptKeys(db), []);
    assert.deepEqual(await nodeIds(db), []);
    assert.equal(
      (await owner.executeInput(caller(), command("valid"))).status,
      "committed",
    );
    assert.equal(authorizations, 1);
    assert.deepEqual(await receiptKeys(db), ["valid"]);
  });
});

test("input-defined kinds cannot bypass normalization through execute or supplied intent", async () => {
  await fixture(async (db) => {
    let normalizations = 0;
    let authorizations = 0;
    const owner = createOwnerCommandBoundary(options(db, {
      handlers: { put, plain: put },
      inputDefinitions: {
        put: {
          normalize(input) {
            normalizations++;
            const id = (input as { id: string }).id;
            if (typeof id !== "string") {
              throw new Error("raw input id required");
            }
            return { intent: { id }, value: input };
          },
        },
      },
      authorize() {
        authorizations++;
      },
    }));
    await owner.acquire(0);
    for (const key of ["before", "same"]) {
      await assert.rejects(
        owner.execute(caller(), {
          kind: "put",
          domain: "logical",
          key,
          intent: { id: key },
        }),
        errorCode("owner_command_invalid"),
      );
    }
    const supplied = {
      ...command("same", { id: "derived" }),
      intent: { id: "forged" },
    };
    assert.equal(
      (await owner.executeInput(caller(), supplied)).status,
      "committed",
    );
    await assert.rejects(
      owner.execute(caller(), {
        kind: "put",
        domain: "logical",
        key: "same",
        intent: { id: "derived" },
      }),
      errorCode("owner_command_invalid"),
    );
    await assert.rejects(
      owner.executeInput(
        caller(),
        command("bypass", { intent: { id: "forged" }, value: null }),
      ),
      /raw input id required/,
    );
    for (const kind of ["plain", "missing", "toString"]) {
      await assert.rejects(
        owner.executeInput(
          caller(),
          command("unregistered", { id: "unregistered" }, kind),
        ),
        errorCode("owner_command_invalid"),
      );
    }
    assert.equal(normalizations, 2);
    assert.equal(authorizations, 1);
    assert.deepEqual(await nodeIds(db), ["derived"]);
    assert.deepEqual(
      (await owner.readReceipt(caller(), { domain: "logical", key: "same" }))
        ?.intent,
      { id: "derived" },
    );
    assert.equal(
      (await owner.execute(caller(), {
        kind: "plain",
        domain: "logical",
        key: "plain",
        intent: { id: "plain" },
      })).status,
      "committed",
    );
    await assert.rejects(
      owner.executeInput(caller(), command("plain", { id: "plain" }, "plain")),
      errorCode("owner_command_invalid"),
    );
  });
});

test("input definitions require a local handler and normalizer at construction", async () => {
  await fixture(async (db) => {
    assert.throws(
      () =>
        createOwnerCommandBoundary(options(db, {
          inputDefinitions: {
            missing: {
              normalize: (input) => ({ intent: input, value: input }),
            },
          },
        })),
      /handler and normalizer/,
    );
    assert.throws(
      () =>
        createOwnerCommandBoundary(options(db, {
          inputDefinitions: {
            put: { normalize: null },
          } as unknown as OwnerCommandBoundaryOptions["inputDefinitions"],
        })),
      /handler and normalizer/,
    );
    assert.deepEqual(await receiptKeys(db), []);
  });
});

test("stopped owner cannot authorize or execute after asynchronous normalization", async () => {
  await fixture(async (db) => {
    const entered = deferred();
    const release = deferred();
    let authorized = 0;
    let handled = 0;
    const owner = createOwnerCommandBoundary(options(db, {
      handlers: {
        put() {
          handled++;
          return null;
        },
      },
      inputDefinitions: {
        put: {
          async normalize(input) {
            entered.resolve();
            await release.promise;
            return { intent: input, value: input };
          },
        },
      },
      authorize() {
        authorized++;
      },
    }));
    await owner.acquire(0);
    const result = owner.executeInput(
      caller(),
      command("stopped", { id: "stopped" }),
    );
    await entered.promise;
    owner.stop();
    release.resolve();
    await assert.rejects(result, errorCode("owner_stopped"));
    assert.equal(authorized, 0);
    assert.equal(handled, 0);
    assert.deepEqual(await nodeIds(db), []);
    assert.deepEqual(await receiptKeys(db), []);
  });
});
