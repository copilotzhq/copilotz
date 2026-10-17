/** Private-port tests. Recording ports are not proof of the sibling Oxian transport. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandBoundary,
  type OwnerInputCommand,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerConnection,
  createOwnerWorkerCallAdmission,
  OwnerCallRejected,
  type OwnerHostCaller,
  type OwnerWorkerCallContext,
} from "./connection.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const COMMAND = "copilotz.owner.command";
const RECEIPT = "copilotz.owner.receipt";
const encoder = new TextEncoder();
const request: OwnerCommand = {
  kind: "put",
  domain: "logical",
  key: "step",
  intent: { id: "note" },
};
const identity = { domain: "logical" as const, key: "step" };
const caller: OwnerCaller = {
  workerId: "worker",
  ownerEpoch: 1,
  connectionId: "connection",
  attemptId: "assignment",
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function stream(value: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(value)));
      controller.close();
    },
  });
}
function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes));
}
function context(
  changes: Partial<OwnerWorkerCallContext> = {},
): OwnerWorkerCallContext {
  return {
    workload: COMMAND,
    metadata: { ownerId: "tenant" },
    signal: new AbortController().signal,
    fence: {
      identity: { workerId: "worker", attemptId: "provisioning", epoch: 7 },
      connectionId: "connection",
      sessionGeneration: 3,
    },
    parent: {
      operationId: "operation",
      streamId: "stream",
      workload: "action",
      metadata: { forgedOwner: "foreign" },
    },
    ...changes,
  };
}
function recordingBoundary(
  overrides: Partial<OwnerCommandBoundary> = {},
): OwnerCommandBoundary {
  return {
    state: "acquired",
    epoch: 1,
    stopped: new Promise<void>(() => {}),
    acquire: () => Promise.resolve(1),
    stop() {},
    project: () => Promise.reject(new Error("Unused projection capability")),
    executeInput: () =>
      Promise.reject(new Error("Unused registered input capability")),
    execute: () =>
      Promise.resolve({ status: "committed", result: { recordIds: ["note"] } }),
    readReceipt: () =>
      Promise.resolve({
        kind: "put",
        intent: { private: "stored-intent" },
        result: { recordIds: ["note"] },
      }),
    ...overrides,
  };
}
function admission(
  owner: OwnerCommandBoundary,
  changes: Partial<Parameters<typeof createOwnerWorkerCallAdmission>[0]> = {},
) {
  return createOwnerWorkerCallAdmission({
    resolveOwner: (id) => id === "tenant" ? owner : undefined,
    resolveAssignment: () => ({ ownerId: "tenant", ctxGranted: true, caller }),
    ...changes,
  });
}

// These cases inspect the private admission port without claiming transport integration.
test("private admission refuses forged owner/worker/grant authority and parentless mutation", async () => {
  let mutations = 0;
  const owner = recordingBoundary({
    execute() {
      mutations++;
      return Promise.resolve({ status: "committed", result: null });
    },
  });
  const port = admission(owner);
  assert.equal(await port.admit(context({ workload: "other" })), undefined);
  assert.equal(await port.admit(context({ parent: undefined })), undefined);
  assert.equal(await port.admitUnassigned(context()), undefined);
  assert.equal(
    await port.admit(
      context({ metadata: { ownerId: "tenant", workerId: "admin" } }),
    ),
    undefined,
  );
  assert.equal(
    await port.admit(context({ metadata: { ownerId: "foreign" } })),
    undefined,
  );
  for (
    const resolved of [
      { ownerId: "foreign", ctxGranted: true, caller },
      { ownerId: "tenant", ctxGranted: false, caller },
      {
        ownerId: "tenant",
        ctxGranted: true,
        caller: { ...caller, workerId: "forged" },
      },
    ]
  ) {
    assert.equal(
      await admission(owner, { resolveAssignment: () => resolved }).admit(
        context(),
      ),
      undefined,
    );
  }
  assert.equal(mutations, 0);
});

test("private admission snapshots host caller data and never trusts parent metadata for authority", async () => {
  const binding = { ...caller, grant: { scope: "authorized" } };
  let captured: OwnerCaller | undefined;
  const owner = recordingBoundary({
    execute(who) {
      captured = who;
      return Promise.resolve({ status: "committed", result: null });
    },
  });
  const original = context();
  const before = structuredClone({
    metadata: original.metadata,
    parent: original.parent,
    fence: original.fence,
  });
  const handler = await admission(owner, {
    resolveAssignment: () => ({
      ownerId: "tenant",
      ctxGranted: true,
      caller: binding,
    }),
  }).admit(original);
  assert.ok(handler);
  binding.grant.scope = "mutated-after-admission";
  const reply = decode(
    await handler({
      input: stream(request),
      signal: new AbortController().signal,
    }),
  );
  assert.equal(reply.ok, true);
  assert.equal((captured?.grant as { scope: string }).scope, "authorized");
  assert.deepEqual({
    metadata: original.metadata,
    parent: original.parent,
    fence: original.fence,
  }, before);
});

test("unassigned receipt recovery uses only authenticated stable worker identity and strips stored intent", async () => {
  const reads: OwnerCaller[] = [];
  let assignments = 0;
  const owner = recordingBoundary({
    readReceipt(who) {
      reads.push(who);
      return Promise.resolve({
        kind: "put",
        intent: { protected: "never-on-wire" },
        result: { eventIds: ["event"] },
      });
    },
  });
  const port = admission(owner, {
    resolveAssignment() {
      assignments++;
      return undefined;
    },
  });
  const handler = await port.admitUnassigned(
    context({ workload: RECEIPT, parent: undefined }),
  );
  assert.ok(handler);
  const bytes = await handler({
    input: stream(identity),
    signal: new AbortController().signal,
  });
  assert.deepEqual(decode(bytes), {
    ok: true,
    value: { kind: "put", result: { eventIds: ["event"] } },
  });
  assert.equal(
    new TextDecoder().decode(bytes).includes("never-on-wire"),
    false,
  );
  assert.deepEqual(reads, [{ workerId: "worker", ownerEpoch: 0 }]);
  assert.equal(assignments, 0);
  const forged = decode(
    await handler({
      input: stream({ ...identity, workerId: "other" }),
      signal: new AbortController().signal,
    }),
  );
  assert.equal(forged.ok, false);
  assert.equal(reads.length, 1);
});

test("unavailable named owners refuse without fallback or assignment resolution", async () => {
  const resolved: string[] = [];
  let assignments = 0;
  const port = createOwnerWorkerCallAdmission({
    resolveOwner(id) {
      resolved.push(id);
      return undefined;
    },
    resolveAssignment() {
      assignments++;
      return { ownerId: "fallback", ctxGranted: true, caller };
    },
  });
  assert.equal(await port.admit(context()), undefined);
  assert.deepEqual(resolved, ["tenant"]);
  assert.equal(assignments, 0);
});

test("host input enforces aggregate byte limits and cancellation without executing a command", async () => {
  let mutations = 0;
  let cancelled = 0;
  let chunks = 0;
  const owner = recordingBoundary({
    execute() {
      mutations++;
      return Promise.resolve({ status: "committed", result: null });
    },
  });
  const handler = await admission(owner).admit(context());
  assert.ok(handler);
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ < 2) controller.enqueue(new Uint8Array(550_001));
    },
    cancel() {
      cancelled++;
    },
  });
  const reply = decode(
    await handler({ input: oversized, signal: new AbortController().signal }),
  );
  assert.equal(reply.ok, false);
  assert.equal(mutations, 0);
  assert.equal(cancelled, 1);
  const abort = new AbortController();
  const stalled = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const pending = handler({ input: stalled, signal: abort.signal });
  abort.abort(new Error("private cancellation detail"));
  assert.deepEqual(decode(await pending), {
    ok: false,
    outcome: "refused",
    code: "owner_call_rejected",
  });
  assert.equal(mutations, 0);
  assert.equal(cancelled, 2);
});

test("host errors reveal stable codes only and preserve indeterminate outcomes", async () => {
  for (
    const [code, outcome] of [["owner_admission_refused", "refused"], [
      "owner_commit_unknown",
      "unknown",
    ], ["persistence_indeterminate", "unknown"]] as const
  ) {
    const owner = recordingBoundary({
      execute() {
        return Promise.reject(
          Object.assign(new Error("SQL and private grant details"), {
            code,
            secret: "hidden",
          }),
        );
      },
    });
    const handler = await admission(owner).admit(context());
    assert.ok(handler);
    assert.deepEqual(
      decode(
        await handler({
          input: stream(request),
          signal: new AbortController().signal,
        }),
      ),
      { ok: false, outcome, code },
    );
  }
  const owner = recordingBoundary({
    execute() {
      return Promise.reject(
        Object.assign(new Error("secret message"), {
          code: "PRIVATE_ACCOUNT_TOKEN",
        }),
      );
    },
  });
  const handler = await admission(owner).admit(context());
  assert.ok(handler);
  assert.deepEqual(
    decode(
      await handler({
        input: stream(request),
        signal: new AbortController().signal,
      }),
    ),
    { ok: false, outcome: "refused", code: "owner_call_rejected" },
  );
});

test("host preserves explicit indeterminate outcomes even with an unlisted storage code", async () => {
  const handler = await admission(recordingBoundary({
    execute() {
      return Promise.reject(
        Object.assign(new Error("private storage details"), {
          indeterminate: true,
          code: "storage_disconnected",
        }),
      );
    },
  })).admit(context());
  assert.ok(handler);
  const reply = decode(
    await handler({
      input: stream(request),
      signal: new AbortController().signal,
    }),
  );
  assert.equal(reply.outcome, "unknown");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "owner_call_rejected");
});

test("host accepts committed JSON below the boundary byte limit without a lower node cap", async () => {
  const result = Array<number>(100_001).fill(0);
  const handler = await admission(recordingBoundary({
    execute: () => Promise.resolve({ status: "committed", result }),
  })).admit(context());
  assert.ok(handler);
  const reply = decode(
    await handler({
      input: stream(request),
      signal: new AbortController().signal,
    }),
  );
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.value, { status: "committed", result });
});

test("host never reports refusal when response encoding fails after execution committed", async () => {
  let commits = 0;
  const handler = await admission(recordingBoundary({
    execute() {
      commits++;
      return Promise.resolve({
        status: "committed",
        result: "x".repeat(1_100_001),
      });
    },
  })).admit(context());
  assert.ok(handler);
  const reply = decode(
    await handler({
      input: stream(request),
      signal: new AbortController().signal,
    }),
  );
  assert.equal(commits, 1);
  assert.equal(reply.ok, false);
  assert.equal(reply.outcome, "unknown");
});

async function fixture(
  run: (
    owner: OwnerCommandBoundary,
    db: Awaited<ReturnType<typeof createTestDatabase>>,
    releaseBlock: ReturnType<typeof deferred<void>>,
    blockEntered: ReturnType<typeof deferred<void>>,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  const releaseBlock = deferred();
  const blockEntered = deferred();
  try {
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    await provisionOwnerCommandSchema(db, "public");
    await db.query(
      "CREATE TABLE grants(worker_id TEXT PRIMARY KEY, allowed BOOLEAN NOT NULL, connection_id TEXT NOT NULL)",
    );
    await db.query("INSERT INTO grants VALUES('worker',TRUE,'connection')");
    const owner = createOwnerCommandBoundary({
      session: db,
      schema: "public",
      ownerId: "tenant",
      holderId: "holder",
      maxGroup: 1,
      inputDefinitions: {
        "execution.complete": {
          normalize: (input) => ({ intent: null, value: input }),
        },
        "action.admit": {
          normalize: (input) => ({ intent: { fixture: true }, value: input }),
        },
      },
      async authorize(tx, who, command, _time, input) {
        if (command.kind === "action.admit") {
          const facts = input as {
            provenance?: unknown;
            constraints?: unknown;
          };
          assert.deepEqual(facts.provenance, { route: "trusted-wrapper" });
          assert.deepEqual(facts.constraints, {
            values: { actorId: "actor" },
            absentKeys: ["privateKind"],
          });
        }
        const grant = await tx.query<
          { allowed: boolean; connection_id: string }
        >("SELECT allowed,connection_id FROM grants WHERE worker_id=$1", [
          who.workerId,
        ]);
        if (
          !grant.rows[0]?.allowed ||
          grant.rows[0].connection_id !== who.connectionId
        ) throw new Error("current grant revoked");
      },
      authenticateReceipt(_tx, who) {
        if (who.workerId !== "worker") {
          throw new Error("worker identity unauthenticated");
        }
      },
      handlers: {
        "execution.complete": () => null,
        "effect.confirm": () => null,
        "action.admit": () => ({ eventId: "safe-root" }),
        async put(intent, ctx) {
          await ctx.tx.query(
            "INSERT INTO nodes(id,namespace,type,name) VALUES($1,'test','note','note')",
            [(intent as { id: string }).id],
          );
          return { recordIds: [(intent as { id: string }).id] };
        },
        async block(_intent, ctx) {
          blockEntered.resolve();
          await releaseBlock.promise;
          await ctx.tx.query("UPDATE grants SET allowed=FALSE");
          return null;
        },
      },
    });
    await owner.acquire(0);
    await run(owner, db, releaseBlock, blockEntered);
  } finally {
    releaseBlock.resolve();
    await db.close();
  }
}

test("real boundary revalidates current grants after delayed input and after queue delay", async () => {
  await fixture(async (owner, db, releaseBlock, blockEntered) => {
    const port = admission(owner);
    const handler = await port.admit(context());
    assert.ok(handler);
    let input!: ReadableStreamDefaultController<Uint8Array>;
    const pending = handler({
      input: new ReadableStream({
        start(controller) {
          input = controller;
        },
      }),
      signal: new AbortController().signal,
    });
    await db.query("UPDATE grants SET allowed=FALSE");
    input.enqueue(encoder.encode(JSON.stringify(request)));
    input.close();
    assert.equal(decode(await pending).ok, false);
    assert.equal((await db.query("SELECT 1 FROM nodes")).rows.length, 0);
    await db.query("UPDATE grants SET allowed=TRUE");
    const block = owner.execute(caller, {
      ...request,
      kind: "block",
      key: "block",
      intent: null,
    });
    await blockEntered.promise;
    const queued = handler({
      input: stream(request),
      signal: new AbortController().signal,
    });
    await delay(0);
    releaseBlock.resolve();
    await block;
    assert.equal(decode(await queued).ok, false);
    assert.equal((await db.query("SELECT 1 FROM nodes")).rows.length, 0);
    assert.equal(
      (await db.query("SELECT 1 FROM owner_receipts WHERE kind='put'")).rows
        .length,
      0,
    );
  });
});

test("real parentless receipt recovery authenticates worker and never grants mutation", async () => {
  await fixture(async (owner) => {
    await owner.execute(caller, request);
    const port = admission(owner);
    const handler = await port.admitUnassigned(
      context({ workload: RECEIPT, parent: undefined }),
    );
    assert.ok(handler);
    assert.deepEqual(
      decode(
        await handler({
          input: stream(identity),
          signal: new AbortController().signal,
        }),
      ),
      { ok: true, value: { kind: "put", result: { recordIds: ["note"] } } },
    );
    const forged = context({
      workload: RECEIPT,
      parent: undefined,
      fence: {
        ...context().fence,
        identity: { ...context().fence.identity, workerId: "other" },
      },
    });
    const other = await port.admitUnassigned(forged);
    assert.ok(other);
    assert.equal(
      decode(
        await other({
          input: stream(identity),
          signal: new AbortController().signal,
        }),
      ).ok,
      false,
    );
    assert.equal(
      await port.admitUnassigned(context({ parent: undefined })),
      undefined,
    );
  });
});

// Client tests below use a structural recording port, not an Oxian peer.
test("client waits for terminal transport completion and forwards deadline/cancellation metadata", async () => {
  const terminal = deferred();
  let calls = 0;
  let settled = false;
  const signal = new AbortController().signal;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost(input) {
      calls++;
      assert.equal(input.workload, COMMAND);
      assert.deepEqual(input.metadata, { ownerId: "tenant" });
      assert.ok(input.signal instanceof AbortSignal);
      assert.equal(input.signal.aborted, false);
      assert.equal(input.deadlineAtMs, 1234);
      assert.deepEqual(decode(input.body as Uint8Array), request);
      return Promise.resolve({
        output: stream({
          ok: true,
          value: { status: "committed", result: null },
        }),
        completed: terminal.promise,
        cancel: () => Promise.resolve(),
      });
    },
  });
  const pending = client.execute(request, { signal, deadlineAtMs: 1234 }).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  await delay(0);
  assert.equal(settled, false);
  terminal.resolve();
  assert.deepEqual(await pending, { status: "committed", result: null });
  assert.equal(calls, 1);
});

test("client preserves owner unknown outcomes and does not automatically retry", async () => {
  let calls = 0;
  let cancellations = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost() {
      calls++;
      return Promise.resolve({
        output: stream({
          ok: false,
          code: "owner_commit_unknown",
          outcome: "unknown",
        }),
        completed: Promise.resolve(),
        cancel() {
          cancellations++;
          return Promise.resolve();
        },
      });
    },
  });
  await assert.rejects(
    client.execute(request),
    (error: unknown) =>
      error instanceof OwnerCallRejected &&
      error.code === "owner_commit_unknown" && error.outcome === "unknown",
  );
  assert.equal(calls, 1);
  // The transport ended successfully even though the owner outcome is unknown.
  assert.equal(cancellations, 0);
});

test("client preserves indeterminate transport loss without retry after output EOF", async () => {
  const error = Object.assign(new Error("connection lost during work"), {
    code: "indeterminate",
    committed: true,
  });
  let calls = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost() {
      calls++;
      return Promise.resolve({
        output: stream({
          ok: true,
          value: { status: "committed", result: null },
        }),
        completed: Promise.reject(error),
        cancel: () => Promise.resolve(),
      });
    },
  });
  await assert.rejects(
    client.execute(request),
    (received) => received === error,
  );
  assert.equal(calls, 1);
});

test("client surfaces terminal transport failure even when the output stream remains open", async () => {
  const terminal = deferred();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0;
  const failure = Object.assign(new Error("transport indeterminate"), {
    code: "indeterminate",
  });
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost() {
      calls++;
      return Promise.resolve({
        output: new ReadableStream({
          start(controller) {
            output = controller;
          },
        }),
        completed: terminal.promise,
        cancel: () => Promise.resolve(),
      });
    },
  });
  const pending = client.execute(request);
  const observed = pending.then(() => "resolved", (error) => error);
  await delay(0);
  terminal.reject(failure);
  try {
    assert.equal(
      await Promise.race([observed, delay(30, "still-pending")]),
      failure,
    );
  } finally {
    try {
      output.close();
    } catch { /* Failure may have cancelled output. */ }
    await observed;
  }
  assert.equal(calls, 1);
});

test("client cancellation after output EOF interrupts the terminal-completion wait", async () => {
  const terminal = deferred();
  const abort = new AbortController();
  let cancelled = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost() {
      return Promise.resolve({
        output: stream({
          ok: true,
          value: { status: "committed", result: null },
        }),
        completed: terminal.promise,
        cancel() {
          cancelled++;
          return Promise.resolve();
        },
      });
    },
  });
  const pending = client.execute(request, { signal: abort.signal });
  const observed = pending.then(() => "resolved", (error) => error);
  await delay(0);
  const reason = new Error("cancelled after EOF");
  abort.abort(reason);
  try {
    assert.equal(
      await Promise.race([observed, delay(30, "still-pending")]),
      reason,
    );
  } finally {
    terminal.resolve();
    await observed;
  }
  assert.equal(cancelled, 1);
});

test("client rejects pre-aborted calls and oversized bodies before contacting the host", async () => {
  let calls = 0;
  const callHost: OwnerHostCaller = () => {
    calls++;
    return Promise.reject(new Error("host must not be called"));
  };
  const client = createOwnerConnection({ ownerId: "tenant", callHost });
  const abort = new AbortController();
  const reason = new Error("already aborted");
  abort.abort(reason);
  await assert.rejects(
    client.execute(request, { signal: abort.signal }),
    (error) => error === reason,
  );
  await assert.rejects(
    client.execute({ ...request, intent: "x".repeat(1_100_001) }),
    /byte limit/,
  );
  assert.equal(calls, 0);
});

test("client bounds aggregate output bytes and cancels the failed call without retry", async () => {
  let calls = 0;
  let cancelled = 0;
  let outputCancelled = 0;
  let chunks = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost() {
      calls++;
      return Promise.resolve({
        output: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (chunks++ < 2) controller.enqueue(new Uint8Array(550_001));
          },
          cancel() {
            outputCancelled++;
          },
        }),
        completed: Promise.resolve(),
        cancel() {
          cancelled++;
          return Promise.resolve();
        },
      });
    },
  });
  await assert.rejects(client.execute(request), /byte limit/);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.equal(outputCancelled, 1);
});

test("client cancellation interrupts pending output and forwards cancellation to the host", async () => {
  const abort = new AbortController();
  let forwarded: AbortSignal | undefined;
  let cancelled = 0;
  let outputCancelled = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost(input) {
      forwarded = input.signal;
      return Promise.resolve({
        output: new ReadableStream<Uint8Array>({
          cancel() {
            outputCancelled++;
          },
        }),
        completed: Promise.resolve(),
        cancel() {
          cancelled++;
          return Promise.resolve();
        },
      });
    },
  });
  const pending = client.execute(request, { signal: abort.signal });
  const observed = pending.then(() => "resolved", (error) => error);
  await delay(0);
  const reason = new Error("cancelled output");
  abort.abort(reason);
  assert.equal(await observed, reason);
  assert.equal(forwarded?.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(outputCancelled, 1);
});

test("client receipt recovery sends only stable identity and maps missing receipts", async () => {
  let calls = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost(input) {
      assert.equal(input.workload, RECEIPT);
      assert.deepEqual(input.metadata, { ownerId: "tenant" });
      assert.deepEqual(decode(input.body as Uint8Array), identity);
      return Promise.resolve({
        output: stream({
          ok: true,
          value: calls++ === 0
            ? { kind: "put", result: { recordIds: ["note"] } }
            : null,
        }),
        completed: Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
  });
  assert.deepEqual(await client.readReceipt(identity), {
    kind: "put",
    result: { recordIds: ["note"] },
  });
  assert.equal(await client.readReceipt(identity), undefined);
  assert.equal(calls, 2);
});

test("host and client codec envelopes accept boundary-compatible JSON depth and node count", async () => {
  let nested: OwnerJson = null;
  for (let depth = 0; depth < 64; depth++) nested = { next: nested };
  for (const result of [nested, Array<number>(100_001).fill(0)]) {
    const handler = await admission(recordingBoundary({
      execute: () => Promise.resolve({ status: "committed", result }),
    })).admit(context());
    assert.ok(handler);
    const client = createOwnerConnection({
      ownerId: "tenant",
      async callHost(input) {
        const output = await handler({
          input: new ReadableStream({
            start(controller) {
              controller.enqueue(input.body as Uint8Array);
              controller.close();
            },
          }),
          signal: input.signal ?? new AbortController().signal,
        });
        return {
          output: new ReadableStream({
            start(controller) {
              controller.enqueue(output);
              controller.close();
            },
          }),
          completed: Promise.resolve(),
          cancel: () => Promise.resolve(),
        };
      },
    });
    const actual = await client.execute(request);
    assert.equal(actual.status, "committed");
    assert.deepEqual(actual.result, result);
  }
});

test("completed owner refusal does not abort or cancel the terminal transport", async () => {
  let cancelled = 0;
  let forwarded: AbortSignal | undefined;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost(input) {
      forwarded = input.signal;
      return Promise.resolve({
        output: stream({
          ok: false,
          outcome: "refused",
          code: "owner_intent_conflict",
        }),
        completed: Promise.resolve(),
        cancel() {
          cancelled++;
          return Promise.resolve();
        },
      });
    },
  });
  await assert.rejects(
    client.execute(request),
    (error) =>
      error instanceof OwnerCallRejected &&
      error.code === "owner_intent_conflict",
  );
  assert.equal(cancelled, 0);
  assert.equal(forwarded?.aborted, false);
});

test("ephemeral projection route requires a live ctx assignment and never uses receipt recovery", async () => {
  let calls = 0;
  const owner = recordingBoundary({
    project(who, kind, input) {
      assert.deepEqual(who, caller);
      assert.equal(kind, "execution.input");
      assert.deepEqual(input, { deliveryId: "delivery" });
      calls++;
      return Promise.resolve({ value: "authorized" });
    },
  });
  const port = admission(owner);
  const requestContext = context({ workload: "copilotz.owner.project" });
  assert.equal(await port.admitUnassigned(requestContext), undefined);
  assert.equal(
    await port.admit({ ...requestContext, parent: undefined }),
    undefined,
  );
  assert.equal(
    await admission(owner, {
      resolveAssignment: () => ({
        ownerId: "tenant",
        ctxGranted: false,
        caller,
      }),
    }).admit(requestContext),
    undefined,
  );
  const handler = await port.admit(requestContext);
  assert.ok(handler);
  const client = createOwnerConnection({
    ownerId: "tenant",
    async callHost(input) {
      assert.equal(input.workload, "copilotz.owner.project");
      const response = await handler({
        input: new ReadableStream({
          start(controller) {
            controller.enqueue(input.body as Uint8Array);
            controller.close();
          },
        }),
        signal: input.signal!,
      });
      return {
        output: new ReadableStream({
          start(controller) {
            controller.enqueue(response);
            controller.close();
          },
        }),
        completed: Promise.resolve(),
        cancel: () => Promise.resolve(),
      };
    },
  });
  assert.deepEqual(
    await client.project("execution.input", { deliveryId: "delivery" }),
    { value: "authorized" },
  );
  assert.equal(calls, 1);
  const malformed = decode(
    await handler({
      input: stream({
        kind: "execution.input",
        input: null,
        authority: "admin",
      }),
      signal: new AbortController().signal,
    }),
  );
  assert.equal(malformed.ok, false);
  assert.equal(calls, 1);
});

test("projection adapter suppresses data if authority cancellation wins after read completion", async () => {
  const abort = new AbortController();
  const handler = await admission(recordingBoundary({
    project() {
      abort.abort(new Error("authority revoked"));
      return Promise.resolve({ privateValue: "must not serialize" });
    },
  })).admit(context({ workload: "copilotz.owner.project" }));
  assert.ok(handler);
  const response = await handler({
    input: stream({ kind: "execution.input", input: null }),
    signal: abort.signal,
  });
  assert.equal(decode(response).ok, false);
  assert.equal(
    new TextDecoder().decode(response).includes("must not serialize"),
    false,
  );
});

test("restricted completion admission survives ctx revocation without granting other commands", async () => {
  const calls: OwnerInputCommand[] = [];
  const port = admission(
    recordingBoundary({
      executeInput(_caller, command) {
        calls.push(command);
        return Promise.resolve({
          status: "committed",
          result: { status: "completed" },
        });
      },
    }),
    {
      resolveAssignment: () => ({
        ownerId: "tenant",
        ctxGranted: false,
        settlementGranted: true,
        caller,
      }),
    },
  );
  const completionContext = context({ workload: "copilotz.owner.complete" });
  const handler = await port.admit(completionContext);
  assert.ok(handler);
  const complete = {
    kind: "execution.complete",
    domain: "logical",
    key: "terminal",
    input: { status: "completed" },
  };
  assert.equal(
    decode(
      await handler({
        input: stream(complete),
        signal: completionContext.signal,
      }),
    ).ok,
    true,
  );
  for (
    const invalid of [request, { ...complete, domain: "incarnation" }, {
      ...complete,
      kind: "execution.claim",
    }, { ...complete, extra: true }]
  ) {
    assert.equal(
      decode(
        await handler({
          input: stream(invalid),
          signal: completionContext.signal,
        }),
      ).ok,
      false,
    );
  }
  assert.equal(calls.length, 1);
  assert.equal(await port.admit(context()), undefined);
  assert.equal(
    await port.admit(context({ workload: "copilotz.owner.project" })),
    undefined,
  );
  assert.equal(
    await port.admit({ ...completionContext, parent: undefined }),
    undefined,
  );
  assert.equal(await port.admitUnassigned(completionContext), undefined);
  assert.equal(
    await admission(recordingBoundary()).admit(completionContext),
    undefined,
  );
});

test("restricted completion rechecks settlement authority after streamed admission", async () => {
  await fixture(async (owner, db) => {
    const port = admission(owner, {
      resolveAssignment: () => ({
        ownerId: "tenant",
        ctxGranted: false,
        settlementGranted: true,
        caller,
      }),
    });
    const handler = await port.admit(
      context({ workload: "copilotz.owner.complete" }),
    );
    assert.ok(handler);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const pending = handler({
      input: new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
      signal: new AbortController().signal,
    });
    await db.query("UPDATE grants SET allowed=FALSE");
    controller.enqueue(
      encoder.encode(
        JSON.stringify({
          kind: "execution.complete",
          domain: "logical",
          key: "terminal",
          input: null,
        }),
      ),
    );
    controller.close();
    assert.equal(decode(await pending).ok, false);
    assert.equal(
      (await db.query("SELECT 1 FROM owner_receipts")).rows.length,
      0,
    );
  });
});

test("completion client selects only the restricted route and preserves terminal refusal", async () => {
  const workloads: string[] = [];
  let cancels = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost(input) {
      workloads.push(input.workload);
      return Promise.resolve({
        output: stream({
          ok: false,
          outcome: "refused",
          code: "ActionOwnershipLost",
        }),
        completed: Promise.resolve(),
        cancel() {
          cancels++;
          return Promise.resolve();
        },
      });
    },
  });
  await assert.rejects(client.complete(request), /restricted completion/);
  await assert.rejects(
    client.complete({
      kind: "execution.complete",
      domain: "logical",
      key: "terminal",
      input: null,
    }),
    (error: unknown) =>
      error instanceof OwnerCallRejected &&
      error.code === "ActionOwnershipLost",
  );
  assert.deepEqual(workloads, ["copilotz.owner.complete"]);
  assert.equal(cancels, 0);
});

test("owner readiness handshake is inert, exact-owner and separately admitted", async () => {
  let ready = false;
  let commands = 0;
  let receipts = 0;
  let projections = 0;
  const owner = recordingBoundary({
    execute() {
      commands++;
      throw new Error("no mutation");
    },
    readReceipt() {
      receipts++;
      throw new Error("no recovery");
    },
    project() {
      projections++;
      throw new Error("no hydration");
    },
  });
  const options = {
    resolveOwner: (id: string) => id === "tenant" ? owner : undefined,
    resolveAssignment: () => undefined,
    authorizeReadiness: () => ready,
  };
  const port = createOwnerWorkerCallAdmission(options);
  const ctx = context({ workload: "copilotz.owner.ready", parent: undefined });
  assert.equal(await port.admitUnassigned(ctx), undefined);
  ready = true;
  const handler = await port.admitUnassigned(ctx);
  assert.ok(handler);
  assert.deepEqual(
    decode(
      await handler({
        input: stream({ protocol: "copilotz.owner.v1" }),
        signal: ctx.signal,
      }),
    ),
    {
      ok: true,
      value: {
        protocol: "copilotz.owner.v1",
        ownerId: "tenant",
        features: ["commands", "projections", "settlement"],
      },
    },
  );
  assert.equal(
    await port.admitUnassigned({ ...ctx, metadata: { ownerId: "foreign" } }),
    undefined,
  );
  assert.equal(
    await port.admitUnassigned({
      ...ctx,
      metadata: { ownerId: "tenant", ctxGranted: true },
    }),
    undefined,
  );
  ready = false;
  assert.equal(
    decode(
      await handler({
        input: stream({ protocol: "copilotz.owner.v1" }),
        signal: ctx.signal,
      }),
    ).ok,
    false,
  );
  assert.equal(commands + receipts + projections, 0);
});

test("readiness client validates exact protocol features and probes again for every session", async () => {
  let calls = 0;
  let reply: unknown = {
    protocol: "copilotz.owner.v1",
    ownerId: "tenant",
    features: ["commands", "projections", "settlement"],
  };
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost(input) {
      assert.equal(input.workload, "copilotz.owner.ready");
      calls++;
      return Promise.resolve({
        output: stream({ ok: true, value: reply }),
        completed: Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
  });
  await client.ready();
  await client.ready();
  assert.equal(calls, 2);
  for (
    const invalid of [null, {
      protocol: "old",
      ownerId: "tenant",
      features: [],
    }, {
      protocol: "copilotz.owner.v1",
      ownerId: "foreign",
      features: ["commands", "projections", "settlement"],
    }, {
      protocol: "copilotz.owner.v1",
      ownerId: "tenant",
      features: ["commands"],
    }]
  ) {
    reply = invalid;
    await assert.rejects(client.ready());
  }
  assert.equal(calls, 6);
});

test("readiness never advertises an owner stopped or replaced during async authorization", async () => {
  for (const stage of [1, 2]) {
    for (const change of ["stop", "replace"]) {
      let stopped = false;
      let checks = 0;
      const original: OwnerCommandBoundary = {
        ...recordingBoundary(),
        get state() {
          return stopped ? "stopped" : "acquired";
        },
      };
      let current = original;
      const port = createOwnerWorkerCallAdmission({
        resolveOwner: () => current,
        resolveAssignment: () => undefined,
        async authorizeReadiness() {
          if (++checks === stage) {
            await delay(0);
            if (change === "stop") stopped = true;
            else current = recordingBoundary();
          }
          return true;
        },
      });
      const ctx = context({
        workload: "copilotz.owner.ready",
        parent: undefined,
      });
      const handler = await port.admitUnassigned(ctx);
      if (stage === 1) assert.equal(handler, undefined);
      else {
        assert.ok(handler);
        assert.equal(
          decode(
            await handler({
              input: stream({ protocol: "copilotz.owner.v1" }),
              signal: ctx.signal,
            }),
          ).ok,
          false,
        );
      }
    }
  }
});

const ROOT = "copilotz.owner.action";
const ROOT_RESULT = "copilotz.owner.action-result";
const rootCommand = {
  kind: "action.admit",
  domain: "logical",
  key: "root",
  input: { actionAlias: "work", provenance: { route: "untrusted" } },
} as const;

test("fixed parentless Action ingress needs independent current authority", async () => {
  const owner = recordingBoundary();
  const base = admission(owner);
  assert.equal(
    await base.admitUnassigned(context({ workload: ROOT, parent: undefined })),
    undefined,
  );
  assert.equal(
    await base.admitUnassigned(
      context({ workload: ROOT_RESULT, parent: undefined }),
    ),
    undefined,
  );
  let resolves = 0;
  const enabled = admission(owner, {
    resolveIngress: () => {
      resolves++;
      return caller;
    },
  });
  assert.equal(await enabled.admit(context({ workload: ROOT })), undefined);
  assert.equal(
    await enabled.admitUnassigned(
      context({
        workload: ROOT,
        parent: undefined,
        metadata: { ownerId: "other" },
      }),
    ),
    undefined,
  );
  assert.equal(resolves, 0);
  assert(
    await enabled.admitUnassigned(
      context({ workload: ROOT, parent: undefined }),
    ),
  );
  assert(
    await enabled.admitUnassigned(
      context({ workload: ROOT_RESULT, parent: undefined }),
    ),
  );
});

test("Action ingress dispatches only named input admission and fixed ordinary result purpose", async () => {
  const calls: unknown[] = [];
  const owner = recordingBoundary({
    executeInput: (who, command) => {
      calls.push([who, command]);
      return Promise.resolve({
        status: "committed",
        result: { eventId: "safe" },
      });
    },
    project: (who, kind, input) => {
      calls.push([who, kind, input]);
      return Promise.resolve({ status: "completed", output: "value" });
    },
  });
  const host = admission(owner, { resolveIngress: () => caller });
  const handler = await host.admitUnassigned(
    context({ workload: ROOT, parent: undefined }),
  );
  assert(handler);
  const signal = new AbortController().signal;
  for (
    const payload of [
      { ...rootCommand, kind: "execution.complete" },
      { ...rootCommand, domain: "incarnation" },
      { ...rootCommand, intent: {} },
      { kind: "action.admit", domain: "logical", key: "root" },
    ]
  ) {
    assert.equal(
      decode(await handler({ input: stream(payload), signal })).ok,
      false,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(
    decode(await handler({ input: stream(rootCommand), signal })).ok,
    true,
  );
  assert.deepEqual(calls[0], [caller, rootCommand]);
  const resultHandler = await host.admitUnassigned(
    context({ workload: ROOT_RESULT, parent: undefined }),
  );
  assert(resultHandler);
  const ref = { eventId: "safe", kind: "action.operation-result" };
  await resultHandler({ input: stream(ref), signal });
  assert.deepEqual(calls[1], [caller, "action.result", ref]);
});

test("ingress revocation and owner replacement during body streaming refuse before execution", async () => {
  for (const change of ["revoke", "replace", "abort", "binding"] as const) {
    let writes = 0;
    const owner = recordingBoundary({
      executeInput: () => {
        writes++;
        return Promise.resolve({ status: "committed", result: null });
      },
    });
    let current = owner;
    let live = true;
    let changed = false;
    const lifetime = new AbortController();
    const host = admission(owner, {
      resolveOwner: () => current,
      resolveIngress: () =>
        live
          ? { ...caller, principal: changed ? "replacement" : "original" }
          : undefined,
    });
    const handler = await host.admitUnassigned(
      context({ workload: ROOT, parent: undefined, signal: lifetime.signal }),
    );
    assert(handler);
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        writer = controller;
      },
    });
    const reply = handler({ input, signal: new AbortController().signal });
    if (change === "revoke") live = false;
    if (change === "replace") current = recordingBoundary();
    if (change === "abort") lifetime.abort("session gone");
    if (change === "binding") changed = true;
    writer.enqueue(encoder.encode(JSON.stringify(rootCommand)));
    writer.close();
    assert.equal(decode(await reply).ok, false);
    assert.equal(writes, 0);
  }
});

test("ingress admission rechecks holder after asynchronous authentication", async () => {
  const gate = deferred();
  let state: "acquired" | "stopped" = "acquired";
  const owner = recordingBoundary({
    get state() {
      return state;
    },
  });
  // Object spread copies accessors in the fixture; use a separate live resolver.
  let current: OwnerCommandBoundary | undefined = owner;
  const host = admission(owner, {
    resolveOwner: () => current,
    resolveIngress: async () => {
      await gate.promise;
      return caller;
    },
  });
  const opening = host.admitUnassigned(
    context({ workload: ROOT, parent: undefined }),
  );
  state = "stopped";
  current = undefined;
  gate.resolve();
  assert.equal(await opening, undefined);
});

test("root client preserves unknown outcome and never retries admission", async () => {
  let calls = 0;
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost: (input) => {
      calls++;
      assert.equal(input.workload, ROOT);
      return Promise.resolve({
        output: stream({
          ok: false,
          outcome: "unknown",
          code: "owner_commit_unknown",
        }),
        completed: Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
  });
  await assert.rejects(
    client.admitAction(rootCommand),
    (error) =>
      error instanceof OwnerCallRejected && error.outcome === "unknown",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.admitAction({ ...rootCommand, kind: "put" }),
    /Invalid named/,
  );
  assert.equal(calls, 1);
});

test("root boundary rejects forged provenance and changed absence restrictions and rechecks queued grants", async () => {
  await fixture(async (owner, db, releaseBlock, blockEntered) => {
    const host = admission(owner, { resolveIngress: () => caller });
    const handler = await host.admitUnassigned(
      context({ workload: ROOT, parent: undefined }),
    );
    assert(handler);
    const valid = {
      ...rootCommand,
      input: {
        provenance: { route: "trusted-wrapper" },
        constraints: {
          values: { actorId: "actor" },
          absentKeys: ["privateKind"],
        },
      },
    };
    const signal = new AbortController().signal;
    for (
      const input of [{
        ...valid.input,
        provenance: { route: "generic-public" },
      }, {
        ...valid.input,
        constraints: {
          values: { actorId: "actor", privateKind: null },
          absentKeys: [],
        },
      }, {
        ...valid.input,
        constraints: { values: { actorId: "actor" }, absentKeys: [] },
      }]
    ) {
      assert.equal(
        decode(await handler({ input: stream({ ...valid, input }), signal }))
          .ok,
        false,
      );
    }
    assert.equal(
      (await db.query("SELECT 1 FROM owner_receipts")).rows.length,
      0,
    );
    const blocker = owner.execute(caller, {
      kind: "block",
      domain: "logical",
      key: "block-root",
      intent: null,
    });
    await blockEntered.promise;
    const queued = handler({ input: stream(valid), signal });
    await delay(0);
    releaseBlock.resolve();
    await blocker;
    assert.equal(decode(await queued).ok, false);
    assert.equal(
      (await db.query("SELECT 1 FROM owner_receipts WHERE kind='action.admit'"))
        .rows.length,
      0,
    );
  });
});

test("restricted effect routes preserve settlement without granting begin or arbitrary reads", async () => {
  const calls: unknown[] = [];
  const owner = recordingBoundary({
    execute: (who, command) => {
      calls.push([who, command]);
      return Promise.resolve({ status: "committed", result: null });
    },
    project: (who, kind, input) => {
      calls.push([who, kind, input]);
      return Promise.resolve({ status: "begun" });
    },
  });
  const port = admission(owner, {
    resolveAssignment: () => ({
      ownerId: "tenant",
      ctxGranted: false,
      settlementGranted: true,
      caller,
    }),
  });
  const settleContext = context({ workload: "copilotz.owner.effect-settle" });
  const stateContext = context({ workload: "copilotz.owner.effect-state" });
  assert.equal(await port.admit(context()), undefined);
  assert.equal(
    await port.admit(context({ workload: "copilotz.owner.project" })),
    undefined,
  );
  assert.equal(
    await port.admitUnassigned({ ...settleContext, parent: undefined }),
    undefined,
  );
  assert.equal(
    await port.admitUnassigned({ ...stateContext, parent: undefined }),
    undefined,
  );
  const settle = await port.admit(settleContext);
  const inspect = await port.admit(stateContext);
  assert(settle);
  assert(inspect);
  const signal = new AbortController().signal;
  for (
    const payload of [
      { ...request, kind: ["effect.confirm"] },
      { ...request, kind: "effect.begin" },
      { ...request, kind: "execution.complete" },
      { ...request, kind: "effect.confirm", domain: "incarnation" },
      { ...request, kind: "effect.notStarted", other: true },
    ]
  ) {
    assert.equal(
      decode(await settle({ input: stream(payload), signal })).ok,
      false,
    );
  }
  assert.equal(calls.length, 0);
  for (const kind of ["effect.confirm", "effect.notStarted"]) {
    const command = { ...request, kind };
    assert.equal(
      decode(await settle({ input: stream(command), signal })).ok,
      true,
    );
  }
  const input = {
    namespace: "space",
    actionRunId: "run",
    step: "send",
    kind: "execution.input",
  };
  await inspect({ input: stream(input), signal });
  assert.deepEqual(calls[2], [caller, "effect.state", input]);
});

test("restricted effect client selects only fixed routes and keeps unknown outcomes", async () => {
  const workloads: string[] = [];
  const client = createOwnerConnection({
    ownerId: "tenant",
    callHost(input) {
      workloads.push(input.workload);
      return Promise.resolve({
        output: stream({
          ok: false,
          outcome: "unknown",
          code: "owner_commit_unknown",
        }),
        completed: Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
  });
  await assert.rejects(
    client.effectSettle({ ...request, kind: "effect.begin" }),
    /restricted effect/,
  );
  await assert.rejects(
    client.effectSettle({ ...request, kind: "effect.confirm" }),
    (error) =>
      error instanceof OwnerCallRejected && error.outcome === "unknown",
  );
  await assert.rejects(
    client.effectState({
      namespace: "space",
      actionRunId: "run",
      step: "send",
    }),
    (error) =>
      error instanceof OwnerCallRejected && error.outcome === "unknown",
  );
  assert.deepEqual(workloads, [
    "copilotz.owner.effect-settle",
    "copilotz.owner.effect-state",
  ]);
});

test("restricted effect settlement revalidates SQL authority after admission", async () => {
  await fixture(async (owner, db) => {
    const port = admission(owner, {
      resolveAssignment: () => ({
        ownerId: "tenant",
        ctxGranted: false,
        settlementGranted: true,
        caller,
      }),
    });
    const handler = await port.admit(
      context({ workload: "copilotz.owner.effect-settle" }),
    );
    assert(handler);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const pending = handler({
      input: new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
      signal: new AbortController().signal,
    });
    await db.query("UPDATE grants SET allowed=FALSE");
    controller.enqueue(
      encoder.encode(JSON.stringify({ ...request, kind: "effect.confirm" })),
    );
    controller.close();
    assert.equal(decode(await pending).ok, false);
    assert.equal(
      (await db.query("SELECT 1 FROM owner_receipts")).rows.length,
      0,
    );
  });
});

test("simple Action calls require host normalization and reject forged trusted fields", async () => {
  const calls: unknown[] = [];
  const owner = recordingBoundary({
    executeInput: (who, command) => {
      calls.push([who, command]);
      return Promise.resolve({ status: "committed", result: null });
    },
  });
  const ctx = context({
    workload: "copilotz.owner.action-call",
    parent: undefined,
  });
  assert.equal(
    await admission(owner, { resolveIngress: () => caller }).admitUnassigned(
      ctx,
    ),
    undefined,
  );
  const host = admission(owner, {
    resolveIngress: () => caller,
    prepareIngressAction: (_context, _id, who, request) => {
      assert.deepEqual(who, caller);
      assert.deepEqual(request, {
        actionAlias: "run",
        input: { value: 1 },
        operationKey: "local",
      });
      return Promise.resolve(rootCommand);
    },
  });
  const handler = await host.admitUnassigned(ctx);
  assert(handler);
  const signal = new AbortController().signal;
  for (
    const payload of [
      { actionAlias: "run", input: {}, provenance: {} },
      { actionAlias: "run", input: {}, metadata: {} },
      { actionAlias: "run", input: {}, operationKey: "" },
      { actionAlias: "run" },
    ]
  ) {
    assert.equal(
      decode(await handler({ input: stream(payload), signal })).ok,
      false,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(
    decode(
      await handler({
        input: stream({
          actionAlias: "run",
          input: { value: 1 },
          operationKey: "local",
        }),
        signal,
      }),
    ).ok,
    true,
  );
  assert.deepEqual(calls, [[caller, rootCommand]]);
});

test("simple Action normalization rechecks current binding and owner after its await", async () => {
  for (const change of ["caller", "owner", "abort"] as const) {
    let writes = 0;
    let currentCaller: OwnerCaller | undefined = caller;
    const owner = recordingBoundary({
      executeInput: () => {
        writes++;
        return Promise.resolve({ status: "committed", result: null });
      },
    });
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const host = admission(owner, {
      resolveIngress: () => currentCaller,
      prepareIngressAction: async () => {
        entered.resolve();
        await release.promise;
        return rootCommand;
      },
    });
    const handler = await host.admitUnassigned(
      context({
        workload: "copilotz.owner.action-call",
        parent: undefined,
        signal: controller.signal,
      }),
    );
    assert(handler);
    const pending = handler({
      input: stream({ actionAlias: "run", input: null }),
      signal: controller.signal,
    });
    await entered.promise;
    if (change === "caller") currentCaller = undefined;
    if (change === "owner") {
      Object.defineProperty(owner, "state", { value: "stopped" });
    }
    if (change === "abort") controller.abort();
    release.resolve();
    assert.equal(decode(await pending).ok, false);
    assert.equal(writes, 0);
  }
});

test("child Action routes require current parent ctx and fix input/result kinds", async () => {
  const calls: unknown[] = [];
  const owner = recordingBoundary({
    executeInput: (who, command) => {
      calls.push([who, command]);
      return Promise.resolve({ status: "committed", result: null });
    },
    project: (who, kind, input) => {
      calls.push([who, kind, input]);
      return Promise.resolve(null);
    },
  });
  const host = admission(owner);
  const signal = new AbortController().signal;
  for (
    const workload of [
      "copilotz.owner.child-action",
      "copilotz.owner.child-result",
    ]
  ) {
    assert.equal(
      await host.admitUnassigned(context({ workload, parent: undefined })),
      undefined,
    );
    assert.equal(
      await admission(owner, {
        resolveAssignment: () => ({
          ownerId: "tenant",
          caller,
          ctxGranted: false,
          settlementGranted: true,
        }),
      }).admit(context({ workload })),
      undefined,
    );
  }
  const handler = await host.admit(
    context({ workload: "copilotz.owner.child-action" }),
  );
  assert(handler);
  const command = {
    kind: "action.child-admit",
    domain: "logical",
    key: "child",
    input: {
      parent: {
        deliveryId: "d",
        dispatchAttemptId: "a",
        operationKey: "parent",
      },
      actionAlias: "child",
      operationKey: "local",
      input: null,
    },
  };
  for (
    const bad of [{ ...command, kind: "action.admit" }, {
      ...command,
      domain: "incarnation",
    }, { ...command, intent: {} }]
  ) {
    assert.equal(
      decode(await handler({ input: stream(bad), signal })).ok,
      false,
    );
  }
  assert.equal(calls.length, 0);
  assert.equal(
    decode(await handler({ input: stream(command), signal })).ok,
    true,
  );
  const result = await host.admit(
    context({ workload: "copilotz.owner.child-result" }),
  );
  assert(result);
  const ref = { eventId: "child" };
  assert.equal(decode(await result({ input: stream(ref), signal })).ok, true);
  assert.deepEqual(calls, [[caller, command], [
    caller,
    "action.child-result",
    ref,
  ]]);
});

test("restricted Processor completion admits only its exact incarnation kind pair", async () => {
  let writes = 0;
  const owner = recordingBoundary({
    execute: () => {
      writes++;
      return Promise.resolve({ status: "committed", result: null });
    },
  });
  const host = admission(owner, {
    resolveAssignment: () => ({
      ownerId: "tenant",
      caller,
      ctxGranted: false,
      settlementGranted: true,
    }),
  });
  const handler = await host.admit(
    context({ workload: "copilotz.owner.complete" }),
  );
  assert(handler);
  const signal = new AbortController().signal;
  for (
    const command of [
      {
        kind: "processor.complete",
        domain: "logical",
        key: "step",
        intent: {},
      },
      {
        kind: "execution.complete",
        domain: "incarnation",
        key: "step",
        intent: {},
      },
      {
        kind: "processor.claim",
        domain: "incarnation",
        key: "step",
        intent: {},
      },
    ]
  ) {
    assert.equal(
      decode(await handler({ input: stream(command), signal })).ok,
      false,
    );
  }
  assert.equal(writes, 0);
  assert.equal(
    decode(
      await handler({
        input: stream({
          kind: "processor.complete",
          domain: "incarnation",
          key: "step",
          intent: {},
        }),
        signal,
      }),
    ).ok,
    true,
  );
  assert.equal(writes, 1);
});
