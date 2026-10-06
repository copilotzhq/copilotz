import { assertEquals } from "@std/assert";
import { observationReadPolicy, watchReadAccess } from "./read-watch.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => resolve = value);
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        timer = setTimeout(
          () => reject(new Error("Watcher check did not complete.")),
          1500,
        )
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

Deno.test("1000 exact-id policies share one bounded watch query after id normalization", async () => {
  const runtime = {};
  const checked = deferred();
  let calls = 0;
  const stops: (() => void)[] = [];
  try {
    for (let index = 0; index < 1000; index++) {
      const id = `thread-${index}`;
      stops.push(
        watchReadAccess({
          runtime,
          namespace: "tenant",
          collection: "thread",
          id,
          policy: observationReadPolicy({ where: { id } }, id),
          query(ids) {
            calls++;
            assertEquals(ids.length, 1000);
            checked.resolve();
            return Promise.resolve(new Set(ids));
          },
          failed(error) {
            throw error;
          },
        }),
      );
    }
    await bounded(checked.promise);
    assertEquals(calls, 1);
  } finally {
    stops.forEach((stop) => stop());
  }
});

Deno.test("read watchers isolate remaining predicates, runtime, namespace and collection", async () => {
  const runtime = {};
  const otherRuntime = {};
  const checked = deferred();
  const idsByGroup: Record<string, readonly string[]> = {};
  const stops: (() => void)[] = [];
  const add = (
    id: string,
    name: string,
    options: {
      runtime?: object;
      namespace?: string;
      collection?: string;
      policy?: { where: Record<string, unknown> };
    } = {},
  ) => {
    stops.push(
      watchReadAccess({
        runtime: options.runtime ?? runtime,
        namespace: options.namespace ?? "tenant",
        collection: options.collection ?? "thread",
        id,
        policy: observationReadPolicy(
          options.policy ??
            { where: { id, ownerId: "owner", status: "active" } },
          id,
        ),
        query(ids) {
          idsByGroup[name] = ids;
          if (Object.keys(idsByGroup).length === 5) checked.resolve();
          return Promise.resolve(new Set(ids));
        },
        failed(error) {
          throw error;
        },
      }),
    );
  };
  try {
    add("a", "same");
    add("b", "never", {
      policy: { where: { status: "active", ownerId: "owner", id: "b" } },
    });
    add("c", "predicate", {
      policy: { where: { id: "c", ownerId: "other", status: "active" } },
    });
    add("d", "runtime", { runtime: otherRuntime });
    add("e", "namespace", { namespace: "other" });
    add("f", "collection", { collection: "message" });
    await bounded(checked.promise);
    assertEquals(idsByGroup, {
      same: ["a", "b"],
      predicate: ["c"],
      runtime: ["d"],
      namespace: ["e"],
      collection: ["f"],
    });
  } finally {
    stops.forEach((stop) => stop());
  }
});

Deno.test("missing resources detach watchers at the next 250ms cadence", async () => {
  const failed = deferred<unknown>();
  let stop!: () => void;
  let calls = 0;
  stop = watchReadAccess({
    runtime: {},
    namespace: "tenant",
    collection: "thread",
    id: "removed",
    query() {
      calls++;
      return Promise.resolve(new Set());
    },
    failed(error) {
      stop();
      failed.resolve(error);
    },
  });
  try {
    const error = await bounded(failed.promise) as {
      code: string;
      status: number;
    };
    assertEquals(error.code, "thread_not_found");
    assertEquals(error.status, 404);
    await delay(270);
    assertEquals(calls, 1);
  } finally {
    stop();
  }
});

Deno.test("watcher query errors are delivered to every active member", async () => {
  const expected = new Error("temporary database failure");
  const errors: unknown[] = [];
  const finished = deferred();
  const stops: (() => void)[] = [];
  try {
    for (const id of ["a", "b"]) {
      stops.push(
        watchReadAccess({
          runtime: sharedRuntime,
          namespace: "tenant",
          collection: "thread",
          id,
          query() {
            return Promise.reject(expected);
          },
          failed(error) {
            errors.push(error);
            if (errors.length === 2) finished.resolve();
          },
        }),
      );
    }
    await bounded(finished.promise);
    assertEquals(errors, [expected, expected]);
  } finally {
    stops.forEach((stop) => stop());
  }
});
const sharedRuntime = {};

Deno.test("unsubscribe cancels future cadence queries and remaining batches of an in-flight check", async () => {
  const runtime = {};
  const queryStarted = deferred();
  const releaseQuery = deferred();
  let calls = 0;
  let failures = 0;
  const stops: (() => void)[] = [];
  for (let index = 0; index < 1001; index++) {
    stops.push(
      watchReadAccess({
        runtime,
        namespace: "tenant",
        collection: "thread",
        id: `thread-${index}`,
        async query() {
          calls++;
          queryStarted.resolve();
          await releaseQuery.promise;
          return new Set();
        },
        failed() {
          failures++;
        },
      }),
    );
  }
  try {
    await bounded(queryStarted.promise);
    stops.forEach((stop) => stop());
    releaseQuery.resolve();
    await delay(270);
    assertEquals(calls, 1);
    assertEquals(failures, 0);
  } finally {
    stops.forEach((stop) => stop());
    releaseQuery.resolve();
  }
  let immediateCalls = 0;
  const stop = watchReadAccess({
    runtime: {},
    namespace: "tenant",
    collection: "thread",
    id: "thread",
    query(ids) {
      immediateCalls++;
      return Promise.resolve(new Set(ids));
    },
    failed() {},
  });
  stop();
  await delay(270);
  assertEquals(immediateCalls, 0);
});

Deno.test("repeated unsubscribe cannot remove a replacement group or its timer", async () => {
  const runtime = {};
  const oldStop = watchReadAccess({
    runtime,
    namespace: "tenant",
    collection: "thread",
    id: "old",
    query(ids) {
      return Promise.resolve(new Set(ids));
    },
    failed() {},
  });
  oldStop();
  const checked = deferred();
  const newStop = watchReadAccess({
    runtime,
    namespace: "tenant",
    collection: "thread",
    id: "new",
    query(ids) {
      checked.resolve();
      return Promise.resolve(new Set(ids));
    },
    failed() {},
  });
  try {
    oldStop();
    await bounded(checked.promise);
  } finally {
    newStop();
  }
});
