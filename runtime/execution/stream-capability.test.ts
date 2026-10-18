import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegisteredInvocationFailure } from "./registered-invocation.ts";
import {
  createRegisteredStreamCapability,
  type RegisteredStreamPort,
} from "./stream-capability.ts";
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => resolve = yes);
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function fixture(
  patch: Partial<RegisteredStreamPort> = {},
  failNotification?: () => void,
) {
  let now = 0, serial = 0, physical = 0, committed = 0;
  const timers = new Map<number, { due: number; run(): void }>();
  const command = new AbortController(), exposed = new AbortController();
  const failure = createRegisteredInvocationFailure(command, exposed);
  const calls: { kind: string; value: unknown; at: number }[] = [];
  const faults: unknown[] = [], pending: Promise<unknown>[] = [];
  const port: RegisteredStreamPort = {
    open(input) {
      calls.push({ kind: "open", value: input, at: now });
      return Promise.resolve({ id: "physical-stream" });
    },
    append(input) {
      calls.push({ kind: "append", value: input, at: now });
      assert.equal(input.expectedOffset, physical);
      const startOffset = physical;
      physical += input.bytes.length;
      return Promise.resolve({ startOffset, endOffset: physical });
    },
    checkpoint(input) {
      calls.push({ kind: "checkpoint", value: input, at: now });
      assert.equal(input.startOffset, committed);
      assert.equal(input.endOffset, physical);
      committed = input.endOffset;
      return Promise.resolve({ committedOffset: committed });
    },
    abort(input, options) {
      calls.push({ kind: "abort", value: { input, options }, at: now });
      return Promise.resolve();
    },
    ...patch,
  };
  const capability = createRegisteredStreamCapability({
    port,
    lifetime: {
      check: failure.check,
      fail: failure.fail,
      isCancelled: () => false,
      commandSignal: command.signal,
      exposedSignal: exposed.signal,
    },
    track(start) {
      if (pending.length >= 100) throw new Error("call capacity");
      const value = start();
      pending.push(value.catch((e) => e));
      return value;
    },
    fail(error) {
      faults.push(error);
      failure.fail(error);
      failNotification?.();
    },
    unsupported() {
      throw new Error("unsupported content capability");
    },
    clock: {
      now: () => now,
      set(run, delay) {
        const id = ++serial;
        timers.set(id, { due: now + delay, run });
        return id;
      },
      clear(id) {
        timers.delete(id as number);
      },
    },
  });
  return {
    ...capability,
    calls,
    faults,
    pending,
    command,
    exposed,
    failure,
    get physical() {
      return physical;
    },
    get committed() {
      return committed;
    },
    get timers() {
      return timers.size;
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.run();
        }
      }
      await flush();
    },
    open: () =>
      capability.streams.open({
        id: "lane",
        mediaType: "text/plain",
        role: "assistant",
      }),
  };
}
const bytes = (n: number) => new Uint8Array(n).fill(65);

test("stream writer checkpoints coalesced acknowledged bytes after one second, never per append", async () => {
  const f = fixture(), writer = await f.open();
  assert.deepEqual(await writer.append({ bytes: bytes(3), appendId: "a" }), {
    startOffset: 0,
    endOffset: 3,
  });
  await f.advance(999);
  await writer.append({ bytes: bytes(2), appendId: "b" });
  assert.equal(f.committed, 0);
  await f.advance(1);
  assert.equal(f.committed, 5);
  assert.equal(f.calls.filter((x) => x.kind === "checkpoint").length, 1);
  assert.equal(f.pending.length, 1);
  await writer.abort();
  f.seal();
  await f.drain();
  assert.deepEqual(f.faults, []);
});

test("continuous streaming does not postpone checkpoint deadlines or spend a call slot per chunk", async () => {
  const f = fixture(), writer = await f.open();
  for (let i = 0; i < 50; i++) {
    await writer.append({ bytes: bytes(1), appendId: String(i) });
    await f.advance(50);
  }
  assert.deepEqual(
    f.calls.filter((x) => x.kind === "checkpoint").map((x) => x.at),
    [1000, 2000],
  );
  assert.equal(f.pending.length, 1);
  assert.equal(f.physical, 50);
  await writer.abort();
  await f.drain();
  assert.equal(f.committed, 40);
  assert.equal(f.timers, 0);
});

test("abort and invocation disposal preserve the prior checkpoint without flushing tentative bytes", async () => {
  for (const dispose of [false, true]) {
    const f = fixture(), writer = await f.open();
    await writer.append({ bytes: bytes(4), appendId: "a" });
    if (dispose) f.seal();
    else await writer.abort({ outcome: "cancelled" });
    await f.drain();
    await f.advance(5000);
    assert.equal(f.committed, 0);
    assert.equal(f.calls.filter((x) => x.kind === "checkpoint").length, 0);
    assert.equal(f.calls.filter((x) => x.kind === "abort").length, 1);
    assert.equal(f.timers, 0);
    assert.deepEqual(f.faults, []);
  }
});

test("a due checkpoint waits the actual append and precedes the next queued append", async () => {
  const appendGate = deferred(), checkpointGate = deferred();
  const order: string[] = [];
  let head = 0, checkpointStarted = false;
  const f = fixture({
    async append(input) {
      order.push(`append:${input.appendId}`);
      if (input.appendId === "held") await appendGate.promise;
      const startOffset = head;
      head += input.bytes.length;
      return { startOffset, endOffset: head };
    },
    async checkpoint(input) {
      order.push("checkpoint");
      checkpointStarted = true;
      await checkpointGate.promise;
      return { committedOffset: input.endOffset };
    },
  });
  const writer = await f.open();
  await writer.append({ bytes: bytes(1), appendId: "first" });
  const held = writer.append({ bytes: bytes(1), appendId: "held" });
  await flush();
  await f.advance(1000);
  const after = writer.append({ bytes: bytes(1), appendId: "after" });
  await flush();
  assert.equal(checkpointStarted, false);
  appendGate.resolve();
  await held;
  await flush();
  assert.equal(checkpointStarted, true);
  assert.deepEqual(order, ["append:first", "append:held", "checkpoint"]);
  checkpointGate.resolve();
  await after;
  assert.deepEqual(order, [
    "append:first",
    "append:held",
    "checkpoint",
    "append:after",
  ]);
  f.seal();
  await f.drain();
});

test("background checkpoint failure aborts invocation signals and retains cleanup until it settles", async () => {
  const error = new Error("checkpoint refused"), cleanup = deferred();
  let abortStarted = false;
  const f = fixture({
    checkpoint: () => Promise.reject(error),
    async abort(_input, options) {
      assert.deepEqual(options, {});
      abortStarted = true;
      await cleanup.promise;
    },
  });
  const writer = await f.open();
  await writer.append({ bytes: bytes(3), appendId: "a" });
  await f.advance(1000);
  assert.equal(f.exposed.signal.aborted, true);
  assert.equal(f.command.signal.aborted, true);
  assert.equal(abortStarted, true);
  let drained = false;
  const draining = f.drain().then(() => drained = true);
  await flush();
  assert.equal(drained, false);
  await assert.rejects(
    writer.append({ bytes: bytes(1), appendId: "b" }),
    (e) => e === error,
  );
  cleanup.resolve();
  await draining;
  assert.equal((await Promise.all(f.pending))[0], error);
});

test("later cleanup uncertainty supersedes an earlier known checkpoint refusal", async () => {
  const known = new Error("refused"),
    unknown = Object.assign(new Error("lost cleanup reply"), {
      outcome: "unknown",
    });
  const f = fixture({
    checkpoint: () => Promise.reject(known),
    abort: () => Promise.reject(unknown),
  });
  const writer = await f.open();
  await writer.append({ bytes: bytes(1), appendId: "a" });
  await f.advance(1000);
  await f.drain();
  assert.throws(f.failure.check, (e) => e === unknown);
  assert.equal((await Promise.all(f.pending))[0], unknown);
});

test("finalization seals admission before waiting a held open and its cleanup", async () => {
  const opened = deferred<{ id: string }>(), aborted = deferred();
  let aborts = 0;
  const f = fixture({
    open: () => opened.promise,
    async abort() {
      aborts++;
      await aborted.promise;
    },
  });
  const opening = f.open();
  const refused = assert.rejects(opening, /closed/);
  await flush();
  f.seal();
  let drained = false;
  const draining = f.drain().then(() => drained = true);
  await flush();
  assert.equal(drained, false);
  assert.equal(aborts, 0);
  opened.resolve({ id: "late" });
  await refused;
  await flush();
  assert.equal(aborts, 1);
  assert.equal(drained, false);
  await assert.rejects(f.open(), /closed/);
  aborted.resolve();
  await draining;
  assert.equal(drained, true);
});

test("append admission bounds the queue and snapshots bytes before suspension", async () => {
  const gate = deferred();
  const seen: number[][] = [];
  let head = 0;
  const f = fixture({
    async append(input) {
      if (!head) await gate.promise;
      seen.push([...input.bytes]);
      const startOffset = head;
      head += input.bytes.length;
      return { startOffset, endOffset: head };
    },
  });
  const writer = await f.open();
  const first = writer.append({ bytes: bytes(1), appendId: "first" });
  const data = bytes(2);
  const second = writer.append({ bytes: data, appendId: "second" });
  data.fill(90);
  await assert.rejects(
    writer.append({ bytes: bytes(1), appendId: "third" }),
    /waiting append/,
  );
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(seen, [[65], [65, 65]]);
  await writer.abort();
  assert.deepEqual(f.faults, []);
});

test("unsupported close cannot fabricate content and still cleans the writer", async () => {
  const f = fixture(), writer = await f.open();
  await writer.append({ bytes: bytes(2), appendId: "a" });
  await assert.rejects(writer.close({ assetId: "asset" }), /unsupported/);
  await f.drain();
  assert.equal(f.exposed.signal.aborted, true);
  assert.equal(f.committed, 0);
  assert.equal(f.calls.filter((x) => x.kind === "abort").length, 1);
});

test("fatal failure closes admission before notification and does not invoke error getters or coercions", () => {
  const command = new AbortController(), exposed = new AbortController();
  let gets = 0, calls = 0;
  const hostile = Object.defineProperty({}, "code", {
    get() {
      gets++;
      throw new Error("getter ran");
    },
  });
  const latch = createRegisteredInvocationFailure(command, exposed, (error) => {
    calls++;
    assert.throws(latch.check, (value) => value === hostile);
    latch.fail(error); // Reentrant notification must not recurse.
    throw new Error("notification failed");
  });
  latch.fail(hostile);
  assert.equal(gets, 0);
  assert.equal(calls, 1);
  assert.throws(latch.check, (error) => error === hostile);
  assert.equal(command.signal.aborted, true);
  assert.equal(exposed.signal.aborted, true);
});

test("reentrant open finalization waits the real opening and refuses its late reply", async () => {
  const gate = deferred<{ id: string }>();
  let aborts = 0;
  const f = fixture({
    open() {
      f.seal();
      return gate.promise;
    },
    abort() {
      aborts++;
      return Promise.resolve();
    },
  });
  const opening = f.open();
  const refused = assert.rejects(opening, /closed/);
  await flush();
  let drained = false;
  const draining = f.drain().then(() => drained = true);
  await flush();
  assert.equal(drained, false);
  assert.equal(aborts, 0);
  gate.resolve({ id: "late" });
  await refused;
  await draining;
  assert.equal(aborts, 1);
});

test("Buffer appends own their bytes and never invoke a slice or byteLength override", async () => {
  const gate = deferred();
  let observed: Uint8Array | undefined;
  const f = fixture({
    async append(input) {
      await gate.promise;
      observed = input.bytes;
      return { startOffset: 0, endOffset: input.bytes.length };
    },
  });
  const writer = await f.open();
  const input = Buffer.from([1, 2, 3]);
  Object.defineProperty(input, "slice", {
    value: () => {
      throw new Error("slice ran");
    },
  });
  Object.defineProperty(input, "byteLength", {
    get() {
      throw new Error("byteLength ran");
    },
  });
  const appending = writer.append({ bytes: input, appendId: "owned" });
  input.fill(9);
  gate.resolve();
  await appending;
  assert.deepEqual([...observed!], [1, 2, 3]);
  await writer.abort();
});

test("failure fixes cleanup intent before abort listeners reenter disposal", async () => {
  const error = new Error("checkpoint failed");
  const f = fixture({ checkpoint: () => Promise.reject(error) });
  const writer = await f.open();
  f.exposed.signal.addEventListener("abort", () => f.seal(), { once: true });
  await writer.append({ bytes: bytes(1), appendId: "a" });
  await f.advance(1000);
  await f.drain();
  const abort = f.calls.find((x) => x.kind === "abort")!.value as {
    input: { outcome: string };
  };
  assert.equal(abort.input.outcome, "failed");
});

test("throwing fatal notifications cannot skip abort or strand actual cleanup", async () => {
  let aborts = 0;
  const checkpointError = new Error("checkpoint refused");
  const cleanupError = Object.assign(new Error("fence unknown"), {
    indeterminate: true,
  });
  const f = fixture({
    checkpoint: () => Promise.reject(checkpointError),
    abort: () => {
      aborts++;
      return Promise.reject(cleanupError);
    },
  }, () => {
    throw new Error("notification failed");
  });
  const writer = await f.streams.open({
    mediaType: "text/plain",
    role: "output",
  });
  await writer.append({ appendId: "a", bytes: new Uint8Array([1]) });
  await f.advance(1000);
  await f.drain();
  assert.equal(aborts, 1);
  assert.equal(await f.pending[0], cleanupError);
  assert.deepEqual(f.faults, [checkpointError, cleanupError]);
});
