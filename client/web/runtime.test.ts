import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ActionTransport,
  type BrowserPlugin,
  createBrowserRuntime,
  type LiveFrame,
  MemoryLiveReads,
  type ReadRequest,
} from "./index.ts";
import { defineView } from "../../runtime/views/index.ts";
const request: ReadRequest = { collection: "counter", id: "a" };
const snapshot = (value: number, seq = 0): LiveFrame => ({
  kind: "snapshot",
  rows: [{ row: { id: "a", value }, order: seq }],
  seq,
  checkpoint: `s${seq}`,
});
const delta = (from: number, to: number, value?: number): LiveFrame => ({
  kind: "delta",
  from,
  to,
  upserts: value === undefined ? [] : [{ row: { id: "a", value }, order: to }],
  removes: [],
  checkpoint: `s${to}`,
});
const counter: BrowserPlugin = {
  id: "counter",
  collections: {
    counter: {
      placement: "server",
      commands: {
        add: {
          mutate: ({ current, input }) => ({
            set: { value: Number(current.value ?? 0) + Number(input) },
          }),
        },
      },
    },
  },
  actions: {
    add: {
      id: "counter.add",
      placement: "server",
      optimistic: {
        collection: "counter",
        command: "add",
        id: () => "a",
      },
    },
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("optimistic commands rebase independently and settle only through each read's owner seq", async () => {
  const live = new MemoryLiveReads();
  live.publish(request, snapshot(10));
  const a = deferred<{ value: unknown; seq: number }>(),
    b = deferred<{ value: unknown; seq: number }>();
  const pending = [a, b];
  const runtime = await createBrowserRuntime({
    plugins: [counter],
    live,
    actions: { invoke: () => pending.shift()!.promise, cancel: async () => {} },
  });
  const observed = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  const first = runtime.actions.add(2), second = runtime.actions.add(3);
  assert.equal(observed.getSnapshot().value?.value, 15);
  live.publish(request, delta(0, 1, 20));
  assert.equal(observed.getSnapshot().value?.value, 25);
  a.reject(new Error("denied"));
  await assert.rejects(first.result());
  assert.equal(observed.getSnapshot().value?.value, 23);
  b.resolve({ value: "ok", seq: 3 });
  await second.result();
  assert.equal(observed.getSnapshot().pending, true);
  live.publish(request, delta(1, 2, 23));
  assert.equal(observed.getSnapshot().pending, true);
  live.publish(request, delta(2, 3));
  assert.equal(observed.getSnapshot().pending, false);
  assert.equal(observed.getSnapshot().value?.value, 23);
  runtime.dispose();
  assert.equal(live.subscriptions, 0);
});

test("terminal after snapshot settles immediately; lagging reads retain their layer", async () => {
  const live = new MemoryLiveReads();
  const list = { collection: "counter" };
  live.publish(request, snapshot(10));
  live.publish(list, snapshot(10));
  const done = deferred<{ value: unknown; seq: number }>();
  const runtime = await createBrowserRuntime({
    plugins: [counter],
    live,
    actions: { invoke: () => done.promise, cancel: async () => {} },
  });
  const one = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  const many = runtime.observe((ctx) => ctx.collections.counter.list());
  const action = runtime.actions.add(2);
  live.publish(request, snapshot(12, 4));
  done.resolve({ value: true, seq: 4 });
  await action.result();
  assert.equal(one.getSnapshot().pending, false);
  assert.equal(many.getSnapshot().pending, true);
  live.publish(list, snapshot(12, 4));
  assert.equal(many.getSnapshot().pending, false);
  runtime.dispose();
});

test("malformed or missing batches are atomic and do not advance checkpoints", async () => {
  const live = new MemoryLiveReads();
  live.publish(request, snapshot(10));
  const runtime = await createBrowserRuntime({ plugins: [counter], live });
  const read = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  assert.throws(
    () => live.publish(request, delta(1, 2, 99)),
    /delivery failed/,
  );
  assert.equal(read.getSnapshot().value?.value, 10);
  assert.equal(live.subscriptions, 0);
  runtime.dispose();
});

test("ordered deltas, window replacement, reset and revocation erase stale private data", async () => {
  const live = new MemoryLiveReads();
  const query = { collection: "counter" };
  live.publish(query, {
    kind: "snapshot",
    rows: [{ row: { id: "b" }, order: 2 }, { row: { id: "a" }, order: 1 }],
    seq: 0,
    checkpoint: "0",
  });
  const runtime = await createBrowserRuntime({ plugins: [counter], live });
  const read = runtime.observe((ctx) => ctx.collections.counter.list());
  assert.deepEqual(read.getSnapshot().value.map((row) => row.id), ["a", "b"]);
  live.publish(query, {
    kind: "delta",
    from: 0,
    to: 2,
    removes: ["a"],
    upserts: [{ row: { id: "c" }, order: 3 }],
    checkpoint: "2",
  });
  assert.deepEqual(read.getSnapshot().value.map((row) => row.id), ["b", "c"]);
  live.publish(query, { kind: "stale" });
  assert.equal(read.getSnapshot().status, "stale");
  live.publish(query, { kind: "reset" });
  assert.equal(read.getSnapshot().value.length, 0);
  live.publish(query, snapshot(9, 5));
  live.publish(query, { kind: "revoked" });
  assert.equal(read.getSnapshot().status, "denied");
  assert.equal(read.getSnapshot().value.length, 0);
  runtime.dispose();
});

test("conditional tracking releases reads and isolates listener exceptions", async () => {
  const live = new MemoryLiveReads();
  let selected = "a";
  let rerenders = 0;
  const runtime = await createBrowserRuntime({ plugins: [counter], live });
  const read = runtime.observe((ctx) => {
    rerenders++;
    return ctx.collections.counter.get(selected);
  });
  read.subscribe(() => {
    throw new Error("subscriber failed");
  });
  let notified = 0;
  read.subscribe(() => notified++);
  selected = "b";
  live.publish(request, snapshot(1));
  assert.equal(live.subscriptions, 1);
  assert.equal(notified, 1);
  const before = rerenders;
  live.publish(request, snapshot(2));
  assert.equal(rerenders, before);
  live.publish({ collection: "counter", id: "b" }, {
    kind: "snapshot",
    rows: [{ row: { id: "b", value: 7 }, order: 0 }],
    seq: 1,
    checkpoint: "1",
  });
  assert.equal(read.getSnapshot().value?.value, 7);
  read.dispose();
  assert.equal(live.subscriptions, 0);
  runtime.dispose();
});

test("client Collections restore before startup; pure commands persist and Views cannot write", async () => {
  const saved: unknown[] = [];
  const startup: unknown[] = [];
  const plugin: BrowserPlugin = {
    id: "local",
    collections: {
      local: {
        placement: "browser",
        storage: "local",
        commands: {
          rename: { mutate: ({ input }) => ({ set: { title: input } }) },
        },
      },
    },
    actions: {
      rename: {
        id: "rename",
        placement: "browser",
        execute(input, ctx) {
          ctx.command("local", "a", "rename", input);
        },
      },
    },
    processors: {
      start: {
        placement: "browser",
        on: "app.started",
        handle(_event, ctx) {
          startup.push(ctx.collections.local.get("a").value?.title);
        },
      },
    },
  };
  const runtime = await createBrowserRuntime({
    plugins: [plugin],
    storage: {
      local: {
        load: () => [{ id: "a", title: "Restored" }],
        save: (_key, rows) => {
          saved.push(rows);
        },
      },
    },
  });
  assert.deepEqual(startup, ["Restored"]);
  const read = runtime.observe((ctx) => ctx.collections.local.get("a"));
  await runtime.actions.rename("Changed").result();
  await runtime.flushStorage();
  assert.equal(read.getSnapshot().value?.title, "Changed");
  assert.equal(saved.length, 1);
  assert.throws(() => {
    (read.getSnapshot().value as Record<string, unknown>).title = "tampered";
  });
  runtime.dispose();
  assert.throws(() => runtime.actions.rename("late"));
});

test("delayed receipt cancels exact operation and remains running until terminal", async () => {
  const terminal = deferred<{ value: unknown; seq: number }>();
  let accepted!: Parameters<ActionTransport["invoke"]>[2]["accepted"];
  const cancelled: string[] = [];
  const runtime = await createBrowserRuntime({
    plugins: [counter],
    actions: {
      invoke(_id, _input, options) {
        accepted = options.accepted;
        return terminal.promise;
      },
      cancel: (id) => {
        cancelled.push(id);
        return Promise.resolve();
      },
    },
  });
  const action = runtime.actions.add(2);
  const cancellation = action.cancel();
  await Promise.resolve();
  accepted("exact-operation");
  await cancellation;
  assert.deepEqual(cancelled, ["exact-operation"]);
  assert.equal(action.status, "running");
  terminal.reject(new Error("cancelled by owner"));
  await assert.rejects(action.result());
  assert.equal(action.status, "failed");
  runtime.dispose();
});

test("View resolution, full/panel density, open hints and nested reads share one observation", async () => {
  const view = defineView<
    unknown,
    unknown,
    import("./types.ts").BrowserViewContext
  >({
    id: "view",
    shows: "test",
    modes: ["full", "panel"],
    renderer: "fake",
    render(_item, ctx) {
      return [
        ctx.hints.mode,
        ctx.hints.width,
        ctx.collections.counter.get("a").value,
      ];
    },
  });
  const live = new MemoryLiveReads();
  live.publish(request, snapshot(1));
  let disposed = false;
  const runtime = await createBrowserRuntime({
    plugins: [counter, { id: "views", views: { view } }],
    live,
    renderer: {
      id: "fake",
      mount(_target, output) {
        assert.equal((output.getSnapshot() as unknown[])[0], "panel");
        return {
          dispose() {
            disposed = true;
          },
        };
      },
    },
  });
  const read = runtime.observe(() =>
    runtime.render({ shows: "test", value: null }, { mode: "full", width: 400 })
  );
  assert.deepEqual((read.getSnapshot() as unknown[]).slice(0, 2), [
    "full",
    400,
  ]);
  const mount = runtime.mount(null, { shows: "test", value: null }, {
    mode: "panel",
  });
  mount.dispose();
  assert.equal(disposed, true);
  assert.throws(
    () => runtime.render({ shows: "test", value: null }, { mode: "unknown" }),
    /No View/,
  );
  runtime.dispose();
});

test("duplicate aliases and plugin cycles fail before live subscriptions", async () => {
  await assert.rejects(
    createBrowserRuntime({ plugins: [counter, { ...counter, id: "other" }] }),
    /Duplicate/,
  );
  const plugins: BrowserPlugin[] = [];
  const cyclic: BrowserPlugin = { id: "cycle", plugins };
  plugins.push(cyclic);
  await assert.rejects(createBrowserRuntime({ plugins: [cyclic] }), /cycle/);
});

test("late detached frames and disposed operations cannot revive a runtime", async () => {
  let receive!: (frame: LiveFrame) => void;
  const terminal = deferred<{ value: unknown; seq: number }>();
  const runtime = await createBrowserRuntime({
    plugins: [counter],
    live: {
      subscribe(_read, callback) {
        receive = callback;
        callback(snapshot(1));
        return () => {};
      },
    },
    actions: { invoke: () => terminal.promise, cancel: async () => {} },
  });
  const read = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  read.dispose();
  receive(delta(0, 1, 20));
  assert.equal(runtime.events.length, 1);
  const action = runtime.actions.add(1);
  await Promise.resolve();
  runtime.dispose();
  receive(snapshot(100));
  terminal.resolve({ value: true, seq: 1 });
  await assert.rejects(action.result(), /disposed/);
  assert.deepEqual(runtime.events, []);
});

test("revocation cannot be undone by a late snapshot on the same subscription", async () => {
  const live = new MemoryLiveReads();
  live.publish(request, snapshot(1));
  const runtime = await createBrowserRuntime({ plugins: [counter], live });
  const read = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  live.publish(request, { kind: "revoked" });
  live.publish(request, snapshot(999, 9));
  assert.equal(read.getSnapshot().status, "denied");
  assert.equal(read.getSnapshot().value, undefined);
  runtime.dispose();
});

test("query Actions cache by input, refresh on deltas, and fence late responses", async () => {
  const live = new MemoryLiveReads();
  const pending = [
    deferred<{ value: unknown; seq: number }>(),
    deferred<{ value: unknown; seq: number }>(),
  ];
  let calls = 0;
  const runtime = await createBrowserRuntime({
    plugins: [counter, {
      id: "queries",
      actions: {
        total: {
          id: "total",
          placement: "server",
          query: { reads: ["counter"] },
        },
      },
    }],
    live,
    actions: { invoke: () => pending[calls++].promise, cancel: async () => {} },
  });
  const output = runtime.observe((ctx) => ctx.readAction("total", {}));
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(output.getSnapshot().status, "loading");
  const queryRead = { collection: "counter", query: { limit: 1 } };
  live.publish(queryRead, snapshot(1));
  live.publish(queryRead, delta(0, 1));
  await Promise.resolve();
  assert.equal(calls, 2);
  pending[1].resolve({ value: 2, seq: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[0].resolve({ value: 1, seq: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(output.getSnapshot().value, 2);
  live.publish(queryRead, { kind: "revoked" });
  assert.equal(output.getSnapshot().status, "denied");
  output.dispose();
  assert.equal(live.subscriptions, 0);
  runtime.dispose();
});

test("optimism reuses full current rows and never invents authorized membership", async () => {
  const live = new MemoryLiveReads();
  live.publish(request, {
    kind: "snapshot",
    rows: [{ row: { id: "a", items: [1] }, order: 0 }],
    seq: 0,
    checkpoint: "0",
  });
  const terminal = deferred<{ value: unknown; seq: number }>();
  const plugin: BrowserPlugin = {
    id: "items",
    collections: {
      counter: {
        placement: "server",
        commands: {
          append: {
            mutate: ({ current }) => ({
              set: { items: [...current.items as number[], 2] },
            }),
          },
        },
      },
    },
    actions: {
      append: {
        id: "append",
        placement: "server",
        optimistic: {
          collection: "counter",
          command: "append",
          id: () => "a",
        },
      },
    },
  };
  const runtime = await createBrowserRuntime({
    plugins: [plugin],
    live,
    actions: {
      invoke: () => terminal.promise,
      cancel: () => Promise.resolve(),
    },
  });
  const read = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  const empty = runtime.observe((ctx) => ctx.collections.counter.list());
  const action = runtime.actions.append({});
  assert.deepEqual(read.getSnapshot().value?.items, [1, 2]);
  assert.equal(empty.getSnapshot().value.length, 0);
  terminal.resolve({ value: true, seq: 1 });
  await action.result();
  runtime.dispose();
});

test("disposed observations cannot expose retained private snapshots", async () => {
  const live = new MemoryLiveReads();
  live.publish(request, snapshot(42));
  const runtime = await createBrowserRuntime({ plugins: [counter], live });
  const output = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  assert.equal(output.getSnapshot().value?.value, 42);
  output.dispose();
  assert.throws(output.getSnapshot, /disposed/);
  runtime.dispose();
  assert.throws(output.getSnapshot, /disposed/);
});

test("processor alias collisions fail and host adapters overlay plugin declarations", async () => {
  const processor = {
    placement: "browser" as const,
    on: "app.started",
    handle() {},
  };
  await assert.rejects(
    createBrowserRuntime({
      plugins: [{ id: "a", processors: { start: processor } }, {
        id: "b",
        processors: { start: processor },
      }],
    }),
    /Duplicate/,
  );
  const selected = () => "host";
  const runtime = await createBrowserRuntime({
    plugins: [{
      id: "adapters",
      adapters: { clipboard: { default: () => "plugin" } },
    }],
    adapters: { clipboard: { default: selected } },
  });
  const observed = runtime.observe((ctx) => ctx.adapters.clipboard.default);
  assert.equal(observed.getSnapshot(), selected);
  runtime.dispose();
});

test("invocations snapshot input before submission and binary reads cannot mutate cached rows", async () => {
  const live = new MemoryLiveReads();
  live.publish(request, {
    kind: "snapshot",
    rows: [{ row: { id: "a", bytes: new Uint8Array([1, 2]) }, order: 0 }],
    seq: 0,
    checkpoint: "0",
  });
  let submitted: unknown;
  const runtime = await createBrowserRuntime({
    plugins: [{
      id: "snapshot",
      collections: { counter: { placement: "server" } },
      actions: { send: { id: "send", placement: "server" } },
    }],
    live,
    actions: {
      invoke(_id, input) {
        submitted = input;
        return Promise.resolve({ value: true, seq: 0 });
      },
      cancel: () => Promise.resolve(),
    },
  });
  const input = { text: "original" };
  const action = runtime.actions.send(input);
  input.text = "changed";
  await action.result();
  assert.deepEqual(submitted, { text: "original" });
  const first = runtime.collections.counter.get("a");
  (first.value!.bytes as Uint8Array)[0] = 99;
  assert.equal(
    (runtime.collections.counter.get("a").value!.bytes as Uint8Array)[0],
    1,
  );
  runtime.dispose();
});

test("browser Processors receive live readable record IDs, never snapshots or empty progress", async () => {
  const live = new MemoryLiveReads();
  live.publish(request, snapshot(1));
  const ids: (string | undefined)[] = [];
  const runtime = await createBrowserRuntime({
    plugins: [counter, {
      id: "processor",
      processors: {
        changed: {
          placement: "browser",
          on: "collection.changed",
          handle(event) {
            ids.push(event.id);
          },
        },
      },
    }],
    live,
  });
  const output = runtime.observe((ctx) => ctx.collections.counter.get("a"));
  assert.deepEqual(ids, []);
  live.publish(request, delta(0, 1));
  assert.deepEqual(ids, []);
  live.publish(request, delta(1, 2, 4));
  assert.deepEqual(ids, ["a"]);
  live.publish(request, snapshot(5, 3));
  assert.deepEqual(ids, ["a"]);
  output.dispose();
  runtime.dispose();
});

test("a cancellation requested before receipt surfaces a later cancellation failure", async () => {
  const terminal = deferred<{ value: unknown; seq: number }>();
  let cancelCalls = 0;
  let accepted!: Parameters<ActionTransport["invoke"]>[2]["accepted"];
  const runtime = await createBrowserRuntime({
    plugins: [counter],
    actions: {
      invoke(_id, _input, options) {
        accepted = options.accepted;
        return terminal.promise;
      },
      cancel: () =>
        ++cancelCalls === 1
          ? Promise.reject(new Error("cancel unavailable"))
          : Promise.resolve(),
    },
  });
  const action = runtime.actions.add(1);
  const cancellation = action.cancel();
  const rejected = assert.rejects(cancellation, /cancel unavailable/);
  await Promise.resolve();
  accepted("operation");
  await rejected;
  assert.equal(action.status, "running");
  assert.match(String(action.error), /cancel unavailable/);
  await action.cancel();
  assert.equal(cancelCalls, 2);
  terminal.resolve({ value: true, seq: 1 });
  await action.result();
  runtime.dispose();
});
