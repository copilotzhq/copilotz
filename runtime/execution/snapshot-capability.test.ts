import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type { OwnerSnapshotPort } from "../owner/connection.ts";
import { createRegisteredReadSnapshot } from "./snapshot-capability.ts";
function fixture(overrides: Partial<OwnerSnapshotPort> = {}) {
  const events: string[] = [], abort = new AbortController();
  let live = true;
  const port: OwnerSnapshotPort = {
    open: () => {
      events.push("open");
      return Promise.resolve("resource");
    },
    read: (_id, request) => {
      events.push("read");
      return Promise.resolve(
        (request as { operation: string }).operation === "get"
          ? { id: "a" }
          : [{ id: "a" }],
      );
    },
    close: () => {
      events.push("close");
      return Promise.resolve();
    },
    ...overrides,
  };
  const readSnapshot = createRegisteredReadSnapshot({
    collections: createPluginRegistry({
      collections: {
        notes: defineCollection({ name: "note", schema: { type: "object" } }),
      },
    }).collections,
    port,
    signal: abort.signal,
    check() {
      if (!live) throw new Error("revoked");
    },
    unsupported(): never {
      throw new Error("unsupported");
    },
    track(work) {
      const result = work();
      void result.catch(() => {});
      return result;
    },
  });
  return {
    readSnapshot,
    events,
    port,
    abort,
    revoke() {
      live = false;
    },
  };
}
type Reader = {
  get(input: { id: string }): Promise<unknown>;
  list(): Promise<unknown>;
};
Deno.test("selection callback closes once, preserves local return and seals retained readers", async () => {
  const f = fixture();
  let retained!: Reader;
  assertEquals(
    await f.readSnapshot(async ({ collections }) => {
      retained = collections.notes as Reader;
      assertEquals(await retained.get({ id: "a" }), { id: "a" });
      return "local calculation";
    }),
    "local calculation",
  );
  assertEquals(f.events, ["open", "read", "close"]);
  assertThrows(() => retained.get({ id: "a" }), Error, "closed");
});
Deno.test("selection callback failure still closes its exact owner resource", async () => {
  const f = fixture(), original = new Error("callback");
  assertEquals(
    await assertRejects(() =>
      f.readSnapshot(() => {
        throw original;
      })
    ),
    original,
  );
  assertEquals(f.events, ["open", "close"]);
});
Deno.test("nested selection refuses without opening another owner resource", async () => {
  const f = fixture();
  await assertRejects(
    () => f.readSnapshot(() => f.readSnapshot(() => null)),
    Error,
    "unsupported",
  );
  assertEquals(f.events, ["open", "close"]);
});
Deno.test("read-only selection exposes no mutation route", async () => {
  const f = fixture();
  await assertRejects(
    () =>
      f.readSnapshot(({ collections }) =>
        (collections.notes as { create(): void }).create()
      ),
    Error,
    "unsupported",
  );
  assertEquals(f.events, ["open", "close"]);
});
Deno.test("caught snapshot read failure cannot become a successful selection result", async () => {
  const f = fixture({ read: () => Promise.reject(new Error("read failed")) });
  await assertRejects(
    () =>
      f.readSnapshot(async ({ collections }) => {
        await (collections.notes as Reader).get({ id: "a" }).catch(() => {});
        return "hidden failure";
      }),
    Error,
    "read failed",
  );
  assertEquals(f.events, ["open", "close"]);
});
Deno.test("unawaited read is sealed and drained when its callback returns", async () => {
  let finish!: (value: { id: string }) => void;
  const raw = new Promise<{ id: string }>((resolve) => {
    finish = resolve;
  });
  const f = fixture({
    read: () => raw,
    close() {
      finish({ id: "a" });
      return Promise.resolve();
    },
  });
  await assertRejects(
    () =>
      f.readSnapshot(({ collections }) => {
        void (collections.notes as Reader).get({ id: "a" });
        return "early";
      }),
    Error,
    "closed",
  );
});
Deno.test("revocation during close cannot expose a successful callback return", async () => {
  const f = fixture({
    close() {
      f.revoke();
      return Promise.resolve();
    },
  });
  await assertRejects(() => f.readSnapshot(() => "private"), Error, "revoked");
});
Deno.test("lost opening acknowledgment never runs callback or invents a close token", async () => {
  const f = fixture({ open: () => Promise.reject(new Error("lost open")) });
  let called = false;
  await assertRejects(
    () =>
      f.readSnapshot(() => {
        called = true;
      }),
    Error,
    "lost open",
  );
  assertEquals(called, false);
  assertEquals(f.events, []);
});
Deno.test("bound snapshot methods cannot be replaced after capability construction", async () => {
  const f = fixture();
  Object.assign(f.port, {
    open: () => Promise.reject(new Error("replacement")),
  });
  assertEquals(await f.readSnapshot(() => 42), 42);
  assertEquals(f.events, ["open", "close"]);
});
for (const callbackFails of [false, true]) {
  Deno.test(`unknown close survives ${callbackFails ? "failed" : "successful"} selection callback`, async () => {
    const cleanup = Object.assign(new Error("unconfirmed cleanup"), {
        code: "owner_snapshot_cleanup_unknown",
      }),
      callback = new Error("ordinary callback failure");
    const f = fixture({ close: () => Promise.reject(cleanup) });
    const error = await assertRejects(() =>
      f.readSnapshot(() => {
        if (callbackFails) throw callback;
        return "not safe to report";
      })
    );
    assertEquals((error as { indeterminate?: boolean }).indeterminate, true);
    assertEquals(
      (error as { code?: string }).code,
      "owner_snapshot_cleanup_unknown",
    );
    if (callbackFails) {
      assertEquals((error as AggregateError).errors, [callback, cleanup]);
    }
  });
}

for (const stage of ["open", "read"] as const) {
  Deno.test(`bare cleanup uncertainty survives snapshot ${stage} failure`, async () => {
    const error = Object.assign(new Error("unknown cleanup"), {
      code: "owner_snapshot_cleanup_unknown",
    });
    const f = fixture(
      stage === "open"
        ? { open: () => Promise.reject(error) }
        : { read: () => Promise.reject(error) },
    );
    const failure = await assertRejects(() =>
      f.readSnapshot(async ({ collections }) =>
        await (collections.notes as Reader).get({ id: "a" })
      )
    );
    assertEquals((failure as { indeterminate?: boolean }).indeterminate, true);
  });
}

Deno.test("identical known read and close failures preserve the original error identity", async () => {
  const error = new Error("known read failure");
  const f = fixture({
    read: () => Promise.reject(error),
    close: () => Promise.reject(error),
  });
  assertEquals(
    await assertRejects(() =>
      f.readSnapshot(async ({ collections }) =>
        await (collections.notes as Reader).get({ id: "a" })
      )
    ),
    error,
  );
});
Deno.test("callback error getters cannot hide unknown cleanup or skip pending read drain", async () => {
  let finish!: (value: { id: string }) => void,
    getterCalls = 0,
    settled = false;
  const raw = new Promise<{ id: string }>((resolve) => {
    finish = resolve;
  });
  const callback = Object.defineProperty(
    new Error("callback"),
    "indeterminate",
    {
      get() {
        getterCalls++;
        throw new Error("getter executed");
      },
    },
  );
  const cleanup = Object.assign(new Error("cleanup"), {
    code: "owner_snapshot_cleanup_unknown",
  });
  const f = fixture({ read: () => raw, close: () => Promise.reject(cleanup) });
  const pending = f.readSnapshot(({ collections }) => {
    void (collections.notes as Reader).get({ id: "a" });
    throw callback;
  }).then(() => {
    settled = true;
    return null;
  }, (error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await new Promise((done) => setTimeout(done, 0));
    assertEquals(settled, false);
    finish({ id: "a" });
    const result = await pending;
    assertEquals((result as { indeterminate?: boolean }).indeterminate, true);
    assertEquals(getterCalls, 0);
  } finally {
    finish({ id: "a" });
    await pending;
  }
});

Deno.test("callback code objects are not coerced while cleanup uncertainty is preserved", async () => {
  let conversions = 0;
  const callback = Object.assign(new Error("callback"), {
    code: {
      [Symbol.toPrimitive]() {
        conversions++;
        throw new Error("coerced");
      },
    },
  });
  const cleanup = Object.assign(new Error("cleanup"), {
    code: "owner_snapshot_cleanup_unknown",
  });
  const f = fixture({ close: () => Promise.reject(cleanup) });
  const result = await assertRejects(() =>
    f.readSnapshot(() => {
      throw callback;
    })
  );
  assertEquals((result as { indeterminate?: boolean }).indeterminate, true);
  assertEquals(conversions, 0);
});
