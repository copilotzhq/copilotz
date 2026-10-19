const test = Deno.test;
import assert from "node:assert/strict";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineView, type ViewContext } from "../views/definition.ts";
import { createPreparationRenderer } from "./preparation.ts";
import type { CommandJson } from "../engine/commands.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const args = () => ({
  shows: "message",
  data: { title: "hello" },
  resources: { channel: { style: { prefix: "Reply:" } } },
  scope: { audience: "channel" },
  signal: new AbortController().signal,
  mapInput: (text: string) => ({ text }),
});
function registry(
  render: (value: { title: string }, context: ViewContext) => unknown,
) {
  return createPluginRegistry({
    views: {
      message: defineView({
        id: "fixture.message.channel",
        shows: "message",
        renderer: "text",
        modes: ["channel"],
        render,
      }),
    },
  });
}

test("preparation renderer uses real registry View/resources and records selected versus generic fallback", async () => {
  let calls = 0;
  const r = createPreparationRenderer({
    registry: registry((value, context) => {
      calls++;
      const prefix =
        (context.resources.channel.style as { prefix: string }).prefix;
      return `${prefix} ${value.title}`;
    }),
  });
  const result = await r.render(args());
  assert.deepEqual(result, {
    input: { text: "Reply: hello" },
    selection: { kind: "registered", id: "fixture.message.channel" },
    hints: { mode: "channel", renderer: "text" },
  });
  assert.equal(calls, 1);
  assert.equal(r.snapshot().pending, 0);
  const generic = await r.render({ ...args(), shows: "unregistered" });
  assert.deepEqual(generic.selection, { kind: "generic" });
  assert.deepEqual(JSON.parse((generic.input as { text: string }).text), {
    title: "hello",
  });
  assert.equal(calls, 1);
  await assert.rejects(
    r.render({ ...args(), hints: { renderer: "html" } }),
    /preparation_renderer_unavailable/,
  );
});

test("preparation renderer keeps timed-out actual View work charged until it settles", async () => {
  const entered = deferred();
  const pending = deferred<string>();
  let slow = true;
  let mapped = 0;
  const r = createPreparationRenderer({
    maxPending: 1,
    timeoutMs: 20,
    registry: registry(() => {
      entered.resolve();
      return slow ? pending.promise : "next";
    }),
  });
  const first = r.render({
    ...args(),
    mapInput: (text) => {
      mapped++;
      return { text };
    },
  });
  await entered.promise;
  await assert.rejects(first, /preparation_timeout/);
  assert.equal(r.snapshot().pending, 1);
  await assert.rejects(r.render(args()), /preparation_busy/);
  pending.resolve("late text");
  await pause();
  assert.equal(r.snapshot().pending, 0);
  assert.equal(mapped, 0);
  slow = false;
  assert.deepEqual((await r.render(args())).input, { text: "next" });
});

test("preparation renderer keeps cancelled actual mapper work charged without delivering late input", async () => {
  const entered = deferred();
  const mapped = deferred<CommandJson>();
  const control = new AbortController();
  const r = createPreparationRenderer({
    maxPending: 1,
    timeoutMs: 1000,
    registry: registry(() => "rendered"),
  });
  const first = r.render({
    ...args(),
    signal: control.signal,
    mapInput: () => {
      entered.resolve();
      return mapped.promise;
    },
  });
  await entered.promise;
  control.abort(new Error("caller left"));
  await assert.rejects(first, /caller left/);
  assert.equal(r.snapshot().pending, 1);
  await assert.rejects(r.render(args()), /preparation_busy/);
  mapped.resolve({ text: "too late" });
  await pause();
  assert.equal(r.snapshot().pending, 0);
  assert.deepEqual((await r.render(args())).input, { text: "rendered" });
});

test("preparation renderer refuses nested show even when View catches its refusal", async () => {
  const r = createPreparationRenderer({
    registry: registry(async (_value, context) => {
      try {
        await context.show({ shows: "message", value: "substitute" });
      } catch { /* A caught refusal must not hide missing provenance. */ }
      return "looks fine";
    }),
  });
  await assert.rejects(r.render(args()), /preparation_nested_unavailable/);
  assert.equal(r.snapshot().pending, 0);
});

test("preparation renderer uses detached input/resources and private cancellation despite signal mutation", async () => {
  const entered = deferred();
  const released = deferred<string>();
  const control = new AbortController();
  let observed = "";
  const r = createPreparationRenderer({
    timeoutMs: 1000,
    registry: registry((value, context) => {
      observed = value.title;
      value.title = "changed inside View";
      (context.resources.channel.style as { prefix: string }).prefix =
        "changed";
      Object.defineProperty(context.signal, "aborted", { value: false });
      entered.resolve();
      return released.promise;
    }),
  });
  const input = { ...args(), signal: control.signal };
  const first = r.render(input);
  await entered.promise;
  assert.equal(input.data.title, "hello");
  assert.equal(input.resources.channel.style.prefix, "Reply:");
  assert.equal(observed, "hello");
  control.abort(new Error("real cancellation"));
  await assert.rejects(first, /real cancellation/);
  assert.equal(r.snapshot().pending, 1);
  released.resolve("late");
  await pause();
  assert.equal(r.snapshot().pending, 0);
});

test("preparation renderer rejects capabilities and aggregate oversized snapshots before evaluation", async () => {
  let calls = 0;
  const r = createPreparationRenderer({
    maxBytes: 200,
    registry: registry(() => {
      calls++;
      return "text";
    }),
  });
  await assert.rejects(
    r.render({ ...args(), data: { title: "x".repeat(130) } }),
    /preparation_limit/,
  );
  const data = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      throw new Error("getter executed");
    },
  });
  await assert.rejects(r.render({ ...args(), data }), /data properties/);
  assert.equal(calls, 0);
  assert.equal(r.snapshot().pending, 0);
  const cancelled = new AbortController();
  cancelled.abort(new Error("already gone"));
  await assert.rejects(
    r.render({ ...args(), signal: cancelled.signal }),
    /already gone/,
  );
  assert.equal(calls, 0);
});

test("preparation renderer bounds mapped output and releases actual failed evaluations", async () => {
  const r = createPreparationRenderer({
    maxBytes: 256,
    registry: registry(() => "text"),
  });
  await assert.rejects(
    r.render({ ...args(), mapInput: () => "x".repeat(300) }),
    /preparation_limit/,
  );
  assert.equal(r.snapshot().pending, 0);
  await assert.rejects(
    r.render({
      ...args(),
      mapInput: () => {
        throw new Error("mapping failed");
      },
    }),
    /mapping failed/,
  );
  assert.equal(r.snapshot().pending, 0);
  assert.deepEqual((await r.render(args())).input, { text: "text" });
});

test("preparation renderer latches unaccounted Collection reads even when View catches them", async () => {
  const r = createPreparationRenderer({
    registry: registry(async (_value, context) => {
      try {
        await context.collections.messages.get({ id: "other" });
      } catch { /* No result may hide an unaccounted read attempt. */ }
      return "looks fine";
    }),
  });
  await assert.rejects(r.render(args()), /preparation_read_unavailable/);
  assert.equal(r.snapshot().pending, 0);
});

test("preparation renderer bounds hint/show/selection identities and the complete result envelope", async () => {
  let evaluations = 0;
  let mappings = 0;
  const registered = registry(() => {
    evaluations++;
    return "rendered";
  });
  const r = createPreparationRenderer({
    registry: registered,
    maxBytes: 256,
  });
  await assert.rejects(
    r.render({ ...args(), hints: { mode: "x".repeat(1024) } }),
    /preparation_limit/,
  );
  await assert.rejects(
    r.render({ ...args(), shows: "x".repeat(1024) }),
    /preparation_limit/,
  );
  const hugeSelection = createPreparationRenderer({
    registry: {
      resolveView: () => ({
        ...registered.views.message,
        id: "x".repeat(1024),
      }),
    },
    maxBytes: 256,
  });
  await assert.rejects(hugeSelection.render(args()), /preparation_limit/);
  assert.equal(evaluations, 0);
  await assert.rejects(
    r.render({
      ...args(),
      mapInput: () => {
        mappings++;
        return { text: "x".repeat(210) };
      },
    }),
    /preparation_limit/,
  );
  assert.equal(mappings, 1);
  assert.equal(r.snapshot().pending, 0);
});

test("preparation renderer rejects View-returned renderer capabilities without invoking them", async () => {
  let disposeCalls = 0;
  let renderCalls = 0;
  const r = createPreparationRenderer({
    registry: registry(() => ({
      render() {
        renderCalls++;
        return "should not run";
      },
      dispose() {
        disposeCalls++;
        return new Promise<void>(() => {});
      },
    })),
  });
  await assert.rejects(r.render(args()), /View data must be inert/);
  assert.equal(disposeCalls, 0);
  assert.equal(renderCalls, 0);
  assert.equal(r.snapshot().pending, 0);
});
