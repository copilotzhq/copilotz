/** Actual SQL resource coordination with explicit stub execution witnesses.
 * Registered worker/local routing is a separate activation gate. */
import { assertEquals, assertRejects } from "@std/assert";
import { setTimeout as delay } from "node:timers/promises";
import { defineCollection } from "../collections/definition.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createOwnerCommandBoundary, type OwnerCaller } from "./boundary.ts";
import type { OwnerChildActionBinding } from "./child-action.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerSnapshotResources,
  type OwnerHistoricalReadPolicy,
} from "./snapshot.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("snapshot test gate timeout")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(options: {
  policy?: OwnerHistoricalReadPolicy;
  noPolicy?: boolean;
  onCleanupUnknown?: (error: Error) => void;
  idle?: number;
  maximum?: number;
  capacity?: number;
  session?: (value: SqlSession) => SqlSession;
  onResolve?: () => Promise<void>;
  captureSignal?: () => AbortSignal;
  current?: () => unknown;
  matches?: () => boolean;
  resolveResult?: (value: OwnerChildActionBinding) => OwnerChildActionBinding;
} = {}) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
  await provisionOwnerCommandSchema(db, "public");
  const owner = createOwnerCommandBoundary({
    session: db,
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    handlers: {},
    authorize() {},
    authenticateReceipt() {},
  });
  const epoch = await owner.acquire(0);
  const parent = new AbortController();
  const state = {
    live: true,
    ctx: true,
    matches: true,
    allow: true,
    resolveCalls: 0,
  };
  const caller = (witness = "fresh"): OwnerCaller => ({
    principal: { kind: "worker", workerId: "worker" },
    ownerEpoch: epoch,
    witness,
  });
  const binding: OwnerChildActionBinding = {
    kind: "action",
    assignment: {
      placement: "worker",
      ownerId: "owner",
      workerId: "worker",
      assignmentId: "assignment",
      sessionId: "session",
      namespace: "space",
      actionId: "work",
      deliveryId: "delivery",
      dispatchAttemptId: "attempt",
      ctxGranted: true,
      settlementGranted: true,
      invocation: {
        actionRunId: "run",
        rootKey: "run",
        operationKey: "run",
        metadata: {},
      },
    },
  };
  const registry = createPluginRegistry({
    collections: {
      notes: defineCollection({
        name: "note",
        schema: { type: "object", properties: { label: { type: "string" } } },
      }),
    },
  });
  const manager = createOwnerSnapshotResources({
    session: options.session?.(db) ?? db,
    schema: "public",
    registry,
    owner,
    ownerId: "owner",
    holderId: "holder",
    capture(who) {
      if (who.witness !== "fresh") return undefined;
      return {
        get signal() {
          return options.captureSignal?.() ?? parent.signal;
        },
        isCurrent: () =>
          (options.current ? options.current() : state.live) as boolean,
        matches: (next) =>
          (options.matches?.() ?? state.matches) && next.witness === "fresh",
      };
    },
    async resolve() {
      state.resolveCalls++;
      await options.onResolve?.();
      const value = {
        ...binding,
        assignment: { ...binding.assignment, ctxGranted: state.ctx },
      } as OwnerChildActionBinding;
      return options.resolveResult?.(value) ?? value;
    },
    authorizeHistorical: options.noPolicy ? undefined : options.policy ??
      (() => state.allow ? { historical: true, filter: {} } : undefined),
    idleTimeoutMs: options.idle ?? 1000,
    maxLifetimeMs: options.maximum ?? 5000,
    maxPendingReads: options.capacity ?? 8,
    onCleanupUnknown: options.onCleanupUnknown,
  });
  return {
    db,
    owner,
    parent,
    state,
    caller,
    manager,
    put: (id: string, label: string) =>
      db.query(
        "INSERT INTO nodes(id,namespace,type,name,data) VALUES($1,'space','note',$1,$2::jsonb)",
        [id, JSON.stringify({ label })],
      ),
    async close() {
      await manager.stop().catch(() => {});
      owner.stop();
      await db.close();
    },
  };
}
const read = { collectionAlias: "notes", operation: "list", query: {} };

Deno.test("owner snapshot opens one resource, reads bounded Collections and releases for successor", async () => {
  const f = await fixture();
  try {
    await f.put("a", "hello");
    const id = await f.manager.open(f.caller());
    await assertRejects(() => f.manager.open(f.caller()));
    assertEquals(
      (await f.manager.read(id, f.caller(), read) as { id: string }[]).map(
        (x) => x.id,
      ),
      ["a"],
    );
    await f.manager.close(id, f.caller());
    const next = await f.manager.open(f.caller());
    await assertRejects(() => f.manager.close(id, f.caller()));
    assertEquals(
      (await f.manager.read(next, f.caller(), read) as unknown[]).length,
      1,
    );
    await f.manager.close(next, f.caller());
  } finally {
    await f.close();
  }
});
Deno.test("ordinary permission is not an implicit historical grant", async () => {
  const f = await fixture({ noPolicy: true });
  try {
    await assertRejects(() => f.manager.open(f.caller()));
    assertEquals(f.state.resolveCalls, 0);
  } finally {
    await f.close();
  }
});
Deno.test("snapshot read needs a fresh exact witness while cleanup survives ctx grant loss", async () => {
  const f = await fixture();
  try {
    const id = await f.manager.open(f.caller());
    await assertRejects(() => f.manager.read(id, f.caller("forged"), read));
    f.state.ctx = false;
    await f.manager.close(id, f.caller());
    f.state.ctx = true;
    const next = await f.manager.open(f.caller());
    await f.manager.close(next, f.caller());
  } finally {
    await f.close();
  }
});
Deno.test("historical permission is rechecked after SQL before result disclosure", async () => {
  let count = 0;
  const f = await fixture({
    policy: () => ++count === 1 ? { historical: true, filter: {} } : undefined,
  });
  try {
    await f.put("a", "hello");
    const id = await f.manager.open(f.caller());
    await assertRejects(() => f.manager.read(id, f.caller(), read));
    await f.manager.stop();
    assertEquals(count, 2);
  } finally {
    await f.close();
  }
});
Deno.test("idle expiry fails final close and releases only its own resource", async () => {
  const f = await fixture({ idle: 20 });
  try {
    const id = await f.manager.open(f.caller());
    await delay(50);
    await assertRejects(() => f.manager.read(id, f.caller(), read));
    // If cleanup is still in progress this close joins it; after confirmed
    // removal an unknown token refuses rather than making expiry look successful.
    await assertRejects(() => f.manager.close(id, f.caller()));
    const next = await f.manager.open(f.caller());
    await assertRejects(() => f.manager.close(id, f.caller()));
    await f.manager.close(next, f.caller());
  } finally {
    await f.close();
  }
});
Deno.test("missing cleanup proof quarantines the bounded resource even after backend returns", async () => {
  const f = await fixture({
    session: (db) => ({
      ...db,
      withReadSnapshot: (operation, options) =>
        db.withReadSnapshot!(operation, { signal: options?.signal }),
    }),
  });
  try {
    const id = await f.manager.open(f.caller());
    const error = await assertRejects(() => f.manager.close(id, f.caller()));
    assertEquals(
      (error as { code?: string }).code,
      "owner_snapshot_cleanup_unknown",
    );
    assertEquals((error as { indeterminate?: boolean }).indeterminate, true);
    await assertRejects(() => f.manager.open(f.caller()));
    await assertRejects(() => f.manager.stop());
  } finally {
    await f.close();
  }
});
Deno.test("late old query continuation cannot disclose data or clear a successor", async () => {
  const entered = gate(), release = gate();
  let hold = true;
  const f = await fixture({
    session: (db) => ({
      ...db,
      withReadSnapshot: (operation, options) =>
        db.withReadSnapshot!(async (scope) => {
          const snapshot = {
            async query<T extends Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ) {
              const result = await scope.snapshot.query<T>(sql, params);
              if (hold && sql.includes('"nodes"')) {
                entered.resolve();
                await release.promise;
              }
              return result;
            },
          };
          return await operation(
            scope.kind === "exclusive"
              ? { kind: "exclusive", snapshot }
              : { ...scope, snapshot },
          );
        }, options),
    }),
  });
  let work: Promise<unknown> | undefined;
  try {
    await f.put("a", "hello");
    const id = await f.manager.open(f.caller());
    work = f.manager.read(id, f.caller(), read);
    const observed = work.catch((error) => error);
    await within(entered.promise);
    await f.manager.close(id, f.caller());
    hold = false;
    const next = await f.manager.open(f.caller());
    release.resolve();
    assertEquals(
      (await observed as { code?: string }).code,
      "ActionOwnershipLost",
    );
    assertEquals(
      (await f.manager.read(next, f.caller(), read) as unknown[]).length,
      1,
    );
    await f.manager.close(next, f.caller());
  } finally {
    release.resolve();
    await work?.catch(() => {});
    await f.close();
  }
});
Deno.test("opening expiry releases backend while detached resolver remains fenced", async () => {
  const entered = gate(), release = gate();
  let hold = true;
  const f = await fixture({
    maximum: 100,
    onResolve: async () => {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  try {
    const opening = f.manager.open(f.caller()).catch((error) => error);
    await within(entered.promise);
    const error = await within(opening);
    assertEquals(error.code, "owner_snapshot_expired");
    hold = false;
    const next = await f.manager.open(f.caller());
    release.resolve();
    assertEquals(await f.manager.read(next, f.caller(), read), []);
    await f.manager.close(next, f.caller());
  } finally {
    release.resolve();
    await f.close();
  }
});
Deno.test("maximum snapshot lifetime expires despite read activity", async () => {
  const f = await fixture({ idle: 1000, maximum: 100 });
  try {
    const id = await f.manager.open(f.caller());
    await f.manager.read(id, f.caller(), read);
    await delay(150);
    await assertRejects(() => f.manager.close(id, f.caller()));
    const next = await f.manager.open(f.caller());
    await f.manager.close(next, f.caller());
  } finally {
    await f.close();
  }
});
Deno.test("pending backend cleanup acknowledgment keeps capacity charged", async () => {
  const entered = gate(), release = gate();
  let hold = true;
  const f = await fixture({
    session: (db) => ({
      ...db,
      async withReadSnapshot(operation, options) {
        let cleanup: "confirmed" | "unknown" = "unknown";
        try {
          return await db.withReadSnapshot!(operation, {
            signal: options?.signal,
            onCleanup(value) {
              cleanup = value;
            },
          });
        } finally {
          if (hold) {
            entered.resolve();
            await release.promise;
          }
          options?.onCleanup?.(cleanup);
        }
      },
    }),
  });
  let closing: Promise<void> | undefined;
  try {
    const id = await f.manager.open(f.caller());
    closing = f.manager.close(id, f.caller());
    await within(entered.promise);
    await assertRejects(() => f.manager.open(f.caller()));
    hold = false;
    release.resolve();
    await within(closing);
    const next = await f.manager.open(f.caller());
    await f.manager.close(next, f.caller());
  } finally {
    release.resolve();
    await closing?.catch(() => {});
    await f.close();
  }
});
Deno.test("duplicate backend cleanup observations quarantine resource", async () => {
  const f = await fixture({
    session: (db) => ({
      ...db,
      withReadSnapshot: (operation, options) =>
        db.withReadSnapshot!(operation, {
          signal: options?.signal,
          onCleanup(value) {
            options?.onCleanup?.(value);
            options?.onCleanup?.(value);
          },
        }),
    }),
  });
  try {
    const id = await f.manager.open(f.caller());
    const error = await assertRejects(() => f.manager.close(id, f.caller()));
    assertEquals(
      (error as { code?: string }).code,
      "owner_snapshot_cleanup_unknown",
    );
    assertEquals((error as { indeterminate?: boolean }).indeterminate, true);
    await assertRejects(() => f.manager.open(f.caller()));
  } finally {
    await f.close();
  }
});
Deno.test("capture signal reentry cannot replace admitted inner resource", async () => {
  const parent = new AbortController();
  let inner: Promise<string> | undefined;
  let start: (() => Promise<string>) | undefined;
  const f = await fixture({
    captureSignal() {
      if (start) {
        const launch = start;
        start = undefined;
        inner = launch();
      }
      return parent.signal;
    },
  });
  try {
    start = () => f.manager.open(f.caller());
    await assertRejects(() => f.manager.open(f.caller()));
    const id = await within(inner!);
    assertEquals(await f.manager.read(id, f.caller(), read), []);
    await f.manager.close(id, f.caller());
  } finally {
    await f.close();
  }
});
Deno.test("asynchronous private current witness refuses before SQL and consumes rejection", async () => {
  const f = await fixture({
    current: () => Promise.reject(new Error("invalid async witness")),
  });
  try {
    await assertRejects(() => f.manager.open(f.caller()));
    await delay(0);
    assertEquals(f.state.resolveCalls, 0);
  } finally {
    await f.close();
  }
});
Deno.test("parent cancellation revokes snapshot reads and successful final close", async () => {
  const f = await fixture();
  try {
    const id = await f.manager.open(f.caller());
    f.parent.abort();
    await assertRejects(() => f.manager.read(id, f.caller(), read));
    await assertRejects(() => f.manager.close(id, f.caller()));
  } finally {
    await f.close();
  }
});
Deno.test("owner stop revokes snapshot reads and successful final close", async () => {
  const f = await fixture();
  try {
    const id = await f.manager.open(f.caller());
    f.owner.stop();
    await assertRejects(() => f.manager.read(id, f.caller(), read));
    await assertRejects(() => f.manager.close(id, f.caller()));
  } finally {
    await f.close();
  }
});

Deno.test("resolver binding is detached before private witness callbacks can mutate its alias", async () => {
  let alias: OwnerChildActionBinding | undefined;
  const f = await fixture({
    resolveResult(value) {
      alias = value;
      return value;
    },
    current() {
      if (alias) Object.assign(alias.assignment, { ctxGranted: true });
      return true;
    },
  });
  try {
    f.state.ctx = false;
    await assertRejects(() => f.manager.open(f.caller()));
  } finally {
    await f.close();
  }
});

Deno.test("private matches revocation is rechecked before backend admission", async () => {
  let live = true;
  const f = await fixture({
    current: () => live,
    matches: () => {
      live = false;
      return true;
    },
  });
  try {
    await assertRejects(() => f.manager.open(f.caller()));
    assertEquals(f.state.resolveCalls, 0);
  } finally {
    await f.close();
  }
});
Deno.test("revocation during close cleanup cannot become successful callback completion", async () => {
  const entered = gate(), release = gate();
  const f = await fixture({
    session: (db) => ({
      ...db,
      async withReadSnapshot(operation, options) {
        try {
          return await db.withReadSnapshot!(operation, options);
        } finally {
          entered.resolve();
          await release.promise;
        }
      },
    }),
  });
  let result: Promise<unknown> | undefined;
  try {
    const id = await f.manager.open(f.caller());
    result = f.manager.close(id, f.caller()).then(
      () => "successful",
      (error) => error.code,
    );
    await within(entered.promise);
    f.parent.abort();
    release.resolve();
    assertEquals(await within(result), "ActionOwnershipLost");
  } finally {
    release.resolve();
    await result;
    await f.close();
  }
});

Deno.test("historical grant is detached before witness callbacks can widen its alias", async () => {
  let alias: { historical: true; filter: Record<string, unknown> } | undefined;
  const f = await fixture({
    current() {
      if (alias) alias.filter = {};
      return true;
    },
    policy() {
      alias = { historical: true, filter: { where: { id: "allowed" } } };
      return alias;
    },
  });
  try {
    await f.put("allowed", "yes");
    await f.put("denied", "no");
    const id = await f.manager.open(f.caller());
    const rows = await f.manager.read(id, f.caller(), read) as { id: string }[];
    assertEquals(rows.map((row) => row.id), ["allowed"]);
    await f.manager.close(id, f.caller());
  } finally {
    await f.close();
  }
});
Deno.test("expired opening continuations retain a bounded global authority budget", async () => {
  const release = gate();
  const f = await fixture({
    capacity: 2,
    maximum: 70,
    onResolve: () => release.promise,
  });
  try {
    for (let i = 0; i < 2; i++) {
      await within(assertRejects(() => f.manager.open(f.caller())));
    }
    assertEquals(f.state.resolveCalls, 2);
    await within(assertRejects(() => f.manager.open(f.caller())));
    assertEquals(f.state.resolveCalls, 2);
    release.resolve();
  } finally {
    release.resolve();
    await f.close();
  }
});
Deno.test("final historical policy cannot change durable epoch and disclose data", async () => {
  let calls = 0;
  const f = await fixture({
    policy: async (tx) => {
      calls++;
      if (calls === 2) {
        // Exclusive PGlite rejects this write. The PG current lane can execute
        // it, so the manager must recheck durable authority after the policy.
        await tx.query("UPDATE owner_epochs SET epoch=epoch+1 WHERE owner=$1", [
          "owner",
        ]);
      }
      return { historical: true, filter: {} };
    },
  });
  try {
    await f.put("private", "historical");
    const id = await f.manager.open(f.caller());
    await assertRejects(() => f.manager.read(id, f.caller(), read));
    assertEquals(calls, 2);
  } finally {
    await f.close();
  }
});

Deno.test("per-read cancellation seals the backend while detached policy remains charged", async () => {
  const entered = gate(), release = gate(), abort = new AbortController();
  const f = await fixture({
    policy: async () => {
      entered.resolve();
      await release.promise;
      return { historical: true, filter: {} };
    },
  });
  let pending: Promise<unknown> | undefined;
  try {
    const id = await f.manager.open(f.caller());
    pending = f.manager.read(id, f.caller(), read, abort.signal);
    const observed = pending.catch((error) => error);
    await within(entered.promise);
    abort.abort();
    await within(assertRejects(() => f.manager.close(id, f.caller())));
    const next = await within(f.manager.open(f.caller()));
    await f.manager.close(next, f.caller());
    release.resolve();
    assertEquals(
      (await observed as { code?: string }).code,
      "ActionOwnershipLost",
    );
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    await f.close();
  }
});

for (const notification of ["throws", "rejects"] as const) {
  Deno.test(`late unknown cleanup notifies after quarantine and survives observer that ${notification}`, async () => {
    const entered = gate(), release = gate();
    const notifications: Error[] = [];
    const f = await fixture({
      onCleanupUnknown(error) {
        notifications.push(error);
        if (notification === "throws") throw new Error("observer failed");
        return Promise.reject(new Error("observer failed"));
      },
      session: (db) => ({
        ...db,
        async withReadSnapshot(operation, options) {
          try {
            return await db.withReadSnapshot!(operation, {
              signal: options?.signal,
            });
          } finally {
            entered.resolve();
            await release.promise;
            // Deliberately omit the cleanup proof, even though native cleanup returned.
          }
        },
      }),
    });
    let stopped: Promise<unknown> | undefined, settled = false;
    try {
      await f.manager.open(f.caller());
      f.parent.abort();
      await within(entered.promise);
      await assertRejects(() => f.manager.open(f.caller()));
      stopped = f.manager.stop().then(() => {
        settled = true;
        return null;
      }, (error) => {
        settled = true;
        return error;
      });
      await delay(0);
      assertEquals(settled, false);
      assertEquals(notifications.length, 0);
      release.resolve();
      const error = await within(stopped);
      assertEquals(notifications, [error]);
      assertEquals((error as { indeterminate?: boolean }).indeterminate, true);
      await assertRejects(() => f.manager.open(f.caller()));
    } finally {
      release.resolve();
      await stopped;
      await f.close();
    }
  });
}
