import { assertEquals, assertRejects } from "@std/assert";
import { ReadLimiter } from "./read-limiter.ts";

Deno.test("read limiter reserves a third of the pool for writers and admits waiters FIFO", async () => {
  const limiter = new ReadLimiter(4);
  assertEquals(limiter.capacity, 2);
  assertEquals(new ReadLimiter(1).capacity, 1);
  assertEquals(new ReadLimiter(2).capacity, 1);
  assertEquals(new ReadLimiter(24).capacity, 16);
  const release = Promise.withResolvers<void>();
  const starts: number[] = [];
  const reads = Array.from({ length: 8 }, (_, id) =>
    limiter.run(async () => {
      starts.push(id);
      if (id < 2) await release.promise;
      return id;
    }));
  await Promise.resolve();
  assertEquals(starts, [0, 1]);
  release.resolve();
  assertEquals(await Promise.all(reads), [0, 1, 2, 3, 4, 5, 6, 7]);
  assertEquals(starts, [0, 1, 2, 3, 4, 5, 6, 7]);
});
Deno.test("capacity waits until its deadline and preserves retry metadata", async () => {
  const limiter = new ReadLimiter(2, 30);
  const release = Promise.withResolvers<void>();
  const active = limiter.run(() => release.promise);
  const started = performance.now();
  try {
    const error = await assertRejects(() =>
      limiter.run(() => Promise.resolve(1))
    );
    assertEquals((error as { code?: string }).code, "read_capacity_timeout");
    assertEquals((error as { retryable?: boolean }).retryable, true);
    assertEquals((error as { retryAfterMs?: number }).retryAfterMs, 50);
    assertEquals(performance.now() - started >= 20, true);
  } finally {
    release.resolve();
    await active;
  }
  assertEquals(await limiter.run(() => Promise.resolve(2)), 2);
});
Deno.test("cancelled waiters release their position without consuming capacity", async () => {
  const limiter = new ReadLimiter(2);
  const release = Promise.withResolvers<void>();
  const active = limiter.run(() => release.promise);
  const abort = new AbortController();
  const cancelled = limiter.run(() => {
    throw new Error("must not start");
  }, { signal: abort.signal });
  const rejection = assertRejects(() => cancelled, Error, "cancelled");
  abort.abort(new Error("cancelled"));
  await rejection;
  const next = limiter.run(() => Promise.resolve(42));
  release.resolve();
  await active;
  assertEquals(await next, 42);
});
Deno.test("retirement drains active work and cancels queued reads as unavailable", async () => {
  const limiter = new ReadLimiter(2);
  const release = Promise.withResolvers<void>();
  const active = limiter.run(() => release.promise);
  const pending = limiter.run(() => Promise.resolve(1));
  const rejection = assertRejects(() => pending);
  const closing = limiter.close();
  assertEquals(
    ((await rejection) as { code?: string }).code,
    "persistence_unavailable",
  );
  release.resolve();
  await Promise.all([active, closing]);
  await assertRejects(
    () => limiter.run(() => Promise.resolve(1)),
    Error,
    "Database closed",
  );
});
