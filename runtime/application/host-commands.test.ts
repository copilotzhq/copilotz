import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createOwnerCommands } from "../engine/commands.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { captureHostCommandJson } from "./host-command-json.ts";
import { createHostCommands, hostDatabaseScopes } from "./host-commands.ts";
import type {
  HostCommandContext,
  HostCommandDefinitions,
} from "./host-command-types.ts";
import { createCopilotzWorker } from "./worker.ts";

/** Deterministic SQL protocol fixture; no WASM or database process. */
function database() {
  type State = {
    epoch: number;
    holder: string;
    writes: string[];
    receipts: Map<string, Record<string, unknown>>;
  };
  let state: State = { epoch: 0, holder: "", writes: [], receipts: new Map() };
  let unknownCommit = false;
  const statements: string[][] = [];
  const session: SqlSession = {
    query<TRow extends Record<string, unknown>>(sql: string) {
      // L's scheduler reads the committed one-wake marker outside a command.
      // This fixture has no registered deadlines; every command query still
      // must use its fenced transaction below.
      if (/^SELECT due_at FROM .*owner_alarms.* WHERE owner=\$1$/.test(sql)) {
        return Promise.resolve({ rows: [] as TRow[] });
      }
      throw new Error("Commands must use the transaction.");
    },
    async transaction(run) {
      let current = structuredClone(state);
      let saved: State | undefined;
      const log: string[] = [];
      statements.push(log);
      const tx: SqlExecutor = {
        query<TRow extends Record<string, unknown>>(
          sql: string,
          params: unknown[] = [],
        ) {
          log.push(sql);
          let rows: Record<string, unknown>[] = [];
          if (sql.includes("SET epoch=epoch+1")) {
            if (current.epoch === params[1]) {
              current.epoch++;
              current.holder = String(params[2]);
              rows = [{ epoch: current.epoch }];
            }
          } else if (sql.includes("SET holder=holder")) {
            if (current.epoch === params[1] && current.holder === params[2]) {
              rows = [{ epoch: current.epoch }];
            }
          } else if (sql === "SAVEPOINT owner_command") {
            saved = structuredClone(current);
          } else if (sql === "ROLLBACK TO SAVEPOINT owner_command") {
            current = saved!;
          } else if (sql.startsWith("SELECT principal,kind,intent,result")) {
            rows = [current.receipts.get(String(params[2]))].filter((row) =>
              !!row
            );
          } else if (
            sql.includes("owner_receipts") && sql.startsWith("INSERT")
          ) {
            current.receipts.set(String(params[2]), {
              principal: params[3],
              kind: params[4],
              intent: JSON.parse(String(params[5])),
              result: JSON.parse(String(params[6])),
            });
          } else if (sql === "WRITE") current.writes.push(String(params[0]));
          else if (sql === "FAIL") {
            return Promise.reject(new Error("query failed"));
          }
          return Promise.resolve({ rows: rows as TRow[] });
        },
      };
      const result = await run(tx);
      state = current;
      if (unknownCommit) {
        unknownCommit = false;
        throw new Error("connection lost after commit");
      }
      return result;
    },
  };
  return {
    session,
    statements,
    get state() {
      return state;
    },
    loseCommit() {
      unknownCommit = true;
    },
  };
}
async function setup(
  definitions: HostCommandDefinitions,
  db = database(),
  admission?: Promise<void>,
) {
  const owner = createOwnerCommands({
    session: db.session,
    schema: "command_test",
    handlers: {},
  });
  await owner.acquire(db.state.epoch);
  const lifetime = new AbortController();
  const host = createHostCommands({
    definitions,
    defaultSchema: "command_test",
    signal: lifetime.signal,
    admit: () => admission ?? Promise.resolve(),
    openScope: () => Promise.resolve(),
  });
  host.install("command_test", owner);
  owner.activate();
  return { ...host, db, owner, lifetime };
}
const definition = (
  execute: HostCommandDefinitions[string]["execute"],
  extras: Partial<HostCommandDefinitions[string]> = {},
) => ({
  namespace: "space",
  principal: "service",
  authorize() {},
  execute,
  ...extras,
});

Deno.test("host JSON captures deeply immutable bounded data without executing accessors", () => {
  const source = { nested: [1, { text: "ok" }] };
  const copy = captureHostCommandJson(source);
  source.nested[0] = 2;
  assertEquals(copy, { nested: [1, { text: "ok" }] });
  assert(Object.isFrozen(copy));
  assert(Object.isFrozen((copy as { nested: unknown[] }).nested));
  for (
    const invalid of [
      undefined,
      NaN,
      Infinity,
      new Date(),
      new Uint8Array(1),
      () => {},
      new Array(2),
      { a: undefined },
      { [Symbol()]: 1 },
    ]
  ) {
    assertThrows(() => captureHostCommandJson(invalid));
  }
  let accessed = false;
  assertThrows(() =>
    captureHostCommandJson({
      get value() {
        accessed = true;
        return 1;
      },
    })
  );
  assertEquals(accessed, false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assertThrows(() => captureHostCommandJson(cycle));
  assertThrows(() => captureHostCommandJson("x".repeat(1024 * 1024)));
  assertEquals(
    captureHostCommandJson(JSON.parse('{"__proto__":{"value":1}}')),
    JSON.parse('{"__proto__":{"value":1}}'),
  );
});

Deno.test("host commands bind receipt to command principal namespace and full captured intent", async () => {
  let writes = 0, authorizations = 0;
  const execute = async (_input: unknown, context: HostCommandContext) => {
    await context.query("WRITE", [String(++writes)]);
    return { writes };
  };
  const host = await setup({
    one: definition(execute, {
      authorize() {
        authorizations++;
      },
    }),
    two: definition(execute),
    principal: definition(execute, { principal: "other" }),
    namespace: definition(execute, { namespace: "other" }),
  });
  const key = { idempotencyKey: "same|key" };
  assertEquals(await host.commands.invoke("one", { a: 1, b: 2 }, key), {
    writes: 1,
  });
  assertEquals(await host.commands.invoke("one", { b: 2, a: 1 }, key), {
    writes: 1,
  });
  assertEquals(authorizations, 2);
  await assertRejects(
    () => host.commands.invoke("one", { a: 2, b: 2 }, key),
    Error,
    "another principal, kind or intent",
  );
  for (const name of ["two", "principal", "namespace"]) {
    await host.commands.invoke(name, { a: 1, b: 2 }, key);
  }
  assertEquals(host.db.state.receipts.size, 4);
  assertEquals(writes, 4);
  for (const statements of host.db.statements.slice(1)) {
    assert(statements[0].includes("SET holder=holder"));
  }
  host.owner.stop();
});

Deno.test("host authorization rejects receipt replay and no-key calls always execute", async () => {
  let allowed = true, writes = 0;
  const host = await setup({
    write: definition(() => ({ writes: ++writes }), {
      authorize() {
        if (!allowed) throw new Error("denied");
      },
    }),
  });
  await host.commands.invoke("write", null, { idempotencyKey: "once" });
  allowed = false;
  await assertRejects(
    () => host.commands.invoke("write", null, { idempotencyKey: "once" }),
    Error,
    "denied",
  );
  allowed = true;
  await host.commands.invoke("write", null);
  await host.commands.invoke("write", null);
  assertEquals(writes, 3);
  assertEquals(host.db.state.receipts.size, 1);
  host.owner.stop();
});

Deno.test("host command input and key are captured before admission awaits", async () => {
  const admitted = Promise.withResolvers<void>();
  const host = await setup(
    { echo: definition((input) => input) },
    undefined,
    admitted.promise,
  );
  const input = { nested: { value: 1 } };
  const options = { idempotencyKey: "original" };
  const result = host.commands.invoke("echo", input, options);
  input.nested.value = 2;
  options.idempotencyKey = "changed";
  admitted.resolve();
  assertEquals(await result, { nested: { value: 1 } });
  assert([...host.db.state.receipts.keys()][0].includes("original"));
  host.owner.stop();
});

Deno.test("host mutation output and receipt roll back together on invalid result or failure", async () => {
  let retained: HostCommandContext | undefined;
  const host = await setup({
    invalid: definition(async (_input, context) => {
      retained = context;
      await context.query("WRITE", ["invalid"]);
      return undefined as never;
    }),
    failed: definition(async (_input, context) => {
      retained = context;
      await context.query("WRITE", ["failed"]);
      throw new Error("callback failed");
    }),
    unawaited: definition((_input, context) => {
      void context.query("FAIL");
      return null;
    }),
  });
  for (const name of ["invalid", "failed", "unawaited"]) {
    await assertRejects(() =>
      host.commands.invoke(name, null, { idempotencyKey: name })
    );
    if (retained) {
      await assertRejects(
        () => retained!.query("WRITE", ["late"]),
        Error,
        "closed",
      );
    }
  }
  assertEquals(host.db.state.writes, []);
  assertEquals(host.db.state.receipts.size, 0);
  host.owner.stop();
});

Deno.test("host query and afterCommit handles revoke at each callback completion", async () => {
  let authorization: HostCommandContext | undefined,
    execution: HostCommandContext | undefined;
  let published = 0;
  const host = await setup({
    write: definition(async (_input, context) => {
      execution = context;
      await assertRejects(
        () => authorization!.query("WRITE", ["late auth"]),
        Error,
        "closed",
      );
      context.afterCommit(() => {
        published++;
      });
      await context.query("WRITE", ["ok"]);
      return { ok: true };
    }, {
      authorize(_input, context) {
        authorization = context;
      },
    }),
  });
  const output = await host.commands.invoke("write", null);
  assert(Object.isFrozen(output));
  await assertRejects(
    () => execution!.query("WRITE", ["late"]),
    Error,
    "closed",
  );
  assertThrows(() => execution!.afterCommit(() => {}), Error, "closed");
  assertEquals(Object.keys(execution!).sort(), [
    "afterCommit",
    "commandTime",
    "query",
    "scope",
    "signal",
  ]);
  assertEquals(published, 1);
  assertEquals(host.db.state.writes, ["ok"]);
  host.owner.stop();
});

Deno.test("host cancellation immediately revokes retained query and rolls back", async () => {
  const entered = Promise.withResolvers<HostCommandContext>();
  const released = Promise.withResolvers<void>();
  const host = await setup({
    write: definition(async (_input, context) => {
      entered.resolve(context);
      await released.promise;
      return null;
    }),
  });
  const result = host.commands.invoke("write", null);
  const context = await entered.promise;
  host.lifetime.abort(new Error("cancelled"));
  await assertRejects(
    () => context.query("WRITE", ["late"]),
    Error,
    "cancelled",
  );
  released.resolve();
  await assertRejects(() => result, Error, "cancelled");
  assertEquals(host.db.state.writes, []);
  host.owner.stop();
});

Deno.test("host unknown commit revokes owner and same-key reacquisition reads receipt", async () => {
  let executions = 0;
  const definitions = {
    write: definition(async (_input, context) => {
      await context.query("WRITE", ["once"]);
      return { executions: ++executions };
    }),
  };
  const first = await setup(definitions);
  first.db.loseCommit();
  await assertRejects(
    () =>
      first.commands.invoke("write", { value: 1 }, { idempotencyKey: "once" }),
    Error,
    "unknown",
  );
  assertEquals(first.owner.state, "stopped");
  const next = await setup(definitions, first.db);
  assertEquals(
    await next.commands.invoke("write", { value: 1 }, {
      idempotencyKey: "once",
    }),
    { executions: 1 },
  );
  await assertRejects(
    () =>
      next.commands.invoke("write", { value: 2 }, { idempotencyKey: "once" }),
    Error,
    "intent",
  );
  assertEquals(first.db.state.writes, ["once"]);
  next.owner.stop();
});

Deno.test("host explicit scopes validate and deduplicate without schema discovery", () => {
  assertEquals(
    hostDatabaseScopes("public", ["first", "first", "second"], {
      write: definition(() => null, { databaseSchema: "third" }),
    }),
    ["first", "second", "third"],
  );
  assertEquals(hostDatabaseScopes("public", undefined, undefined), []);
  for (const bad of ["", " unsafe", "bad-name", "public;drop"]) {
    assertThrows(() => hostDatabaseScopes("public", [bad], undefined));
  }
  assertThrows(() =>
    hostDatabaseScopes(
      "public",
      undefined,
      {
        bad: {
          namespace: "space",
          principal: "host",
          execute() {
            return null;
          },
        },
      } as never,
    )
  );
});

Deno.test("workers dynamically reject host command and startup scope options", async () => {
  for (const key of ["hostCommands", "databaseScopes"]) {
    await assertRejects(
      () =>
        createCopilotzWorker(
          {
            transport: { type: "in-process", config: { topic: "unused" } },
            [key]: {},
          } as never,
        ),
      TypeError,
      "Workers accept",
    );
  }
});

Deno.test("same command and key separate namespace principal and database scope tuples", async () => {
  const ownerDb = database();
  let writes = 0;
  const variants = [
    { databaseSchema: "command_test", namespace: "a|b", principal: "c" },
    { databaseSchema: "command_test", namespace: "a", principal: "b|c" },
    { databaseSchema: "command_test", namespace: "a|b", principal: "other" },
    { databaseSchema: "other_schema", namespace: "a|b", principal: "c" },
  ];
  for (const scope of variants) {
    const owner = createOwnerCommands({
      session: ownerDb.session,
      schema: scope.databaseSchema,
      handlers: {},
    });
    await owner.acquire(ownerDb.state.epoch);
    const host = createHostCommands({
      definitions: { same: definition(() => ({ writes: ++writes }), scope) },
      defaultSchema: scope.databaseSchema,
      signal: owner.signal,
      admit: () => Promise.resolve(),
      openScope: () => Promise.resolve(),
    });
    host.install(scope.databaseSchema, owner);
    owner.activate();
    assertEquals(
      await host.commands.invoke("same", null, { idempotencyKey: "key" }),
      { writes },
    );
    assertEquals(
      await host.commands.invoke("same", null, { idempotencyKey: "key" }),
      { writes },
    );
    owner.stop();
  }
  assertEquals(writes, 4);
  assertEquals(ownerDb.state.receipts.size, 4);
});

Deno.test("receipt canonicalization is independent of locale-equivalent property order", async () => {
  let executions = 0;
  const host = await setup({ canonical: definition(() => ++executions) });
  const input = { "é": 1, "é": 2 };
  const reordered = { "é": 2, "é": 1 };
  assertEquals(
    await host.commands.invoke("canonical", input, {
      idempotencyKey: "unicode",
    }),
    1,
  );
  assertEquals(
    await host.commands.invoke("canonical", reordered, {
      idempotencyKey: "unicode",
    }),
    1,
  );
  host.owner.stop();
});

Deno.test("synchronous callbacks revoke SQL before their scheduled microtasks run", async () => {
  let late: Promise<unknown> | undefined;
  const host = await setup({
    write: definition((_input, context) => {
      queueMicrotask(() => {
        late = context.query("WRITE", ["escaped"]).catch((error) => error);
      });
      return null;
    }),
  });
  await host.commands.invoke("write", null);
  const error = await late;
  assert(error instanceof Error && error.message.includes("closed"));
  assertEquals(host.db.state.writes, []);
  host.owner.stop();
});
