import { assert, assertEquals, assertRejects } from "@std/assert";
import { createBrowserRuntime } from "./runtime.ts";
import { urlStorageAdapter } from "./storage.ts";
import type {
  BrowserPlugin,
  BrowserViewContext,
  Observation,
} from "./types.ts";
import { defineView } from "../../runtime/views/definition.ts";
import { MemorySubscriptions, tick } from "../testing/live-transport.test.ts";

const local: BrowserPlugin = {
  id: "local",
  collections: {
    local: {
      placement: "browser",
      storage: "disk",
      initial: [{ id: "a", text: "first" }, { id: "b", text: "second" }],
      commands: { set: { mutate: ({ input }) => ({ set: { text: input } }) } },
    },
  },
  actions: {
    set: {
      id: "set",
      placement: "browser",
      execute(input, ctx) {
        const { id, text } = input as { id: string; text: string };
        ctx.command("local", id, "set", text);
      },
    },
  },
};
const view = (
  id: string,
  render: (value: unknown, ctx: BrowserViewContext) => unknown,
) =>
  defineView<unknown, unknown, BrowserViewContext>({
    id,
    shows: id,
    modes: ["full"],
    renderer: "fake",
    render,
  });
const storage = { disk: { load: () => undefined, save() {} } };

Deno.test("readAction reports denied/unavailable/invalid detail and refreshes with progress-only dependencies", async () => {
  const memory = new MemorySubscriptions();
  const selections: unknown[] = [];
  let cause: unknown = Object.assign(new Error("Offline"), {
    status: 503,
    code: "offline",
  });
  let result: unknown = "ready", calls = 0;
  const runtime = await createBrowserRuntime({
    plugins: [{
      id: "query",
      collections: { entry: { placement: "server" } },
      actions: {
        total: {
          id: "total",
          placement: "server",
          query: { reads: ["entry"] },
        },
      },
    }],
    live: {
      observe(collection, query, options) {
        selections.push({
          collection,
          query,
          progressOnly: options.progressOnly,
        });
        return memory.observe(collection, query, options);
      },
    },
    actions: {
      invoke() {
        calls++;
        if (cause) throw cause;
        return Promise.resolve({ value: result, seq: "1" });
      },
      async cancel() {},
    },
  });
  try {
    const query = runtime.observe((ctx) => ctx.readAction("total", {}));
    await tick();
    assertEquals(selections, [{
      collection: "entry",
      query: {},
      progressOnly: true,
    }]);
    // A failed attempt is not a reconnect: nothing retries it but refresh().
    assertEquals(query.getSnapshot().status, "failed");
    assertEquals(query.getSnapshot().error, {
      kind: "unavailable",
      code: "offline",
      message: "Offline",
      status: 503,
      retryable: true,
    });
    cause = Object.assign(new Error("Bad input"), {
      status: 422,
      code: "invalid_input",
    });
    query.getSnapshot().refresh();
    await tick();
    assertEquals(query.getSnapshot().error?.kind, "invalid");
    assertEquals(query.getSnapshot().status, "failed");
    cause = Object.assign(new Error("Forbidden"), {
      status: 403,
      code: "forbidden",
    });
    query.getSnapshot().refresh();
    await tick();
    assertEquals(query.getSnapshot().status, "denied");
    assertEquals(query.getSnapshot().error?.kind, "denied");
    cause = undefined;
    query.getSnapshot().refresh();
    await tick();
    assertEquals(query.getSnapshot().value, "ready");
    assertEquals(query.getSnapshot().error, undefined);
    result = {
      ok: false,
      error: { code: "invalid_input", message: "Rejected", status: 400 },
    };
    query.getSnapshot().refresh();
    await tick();
    assertEquals(query.getSnapshot().error?.kind, "invalid");
    await memory.publish({ collection: "entry", progressOnly: true }, {
      t: "revoked",
      reason: "permission",
    });
    assertEquals(query.getSnapshot().status, "denied");
    result = "restored";
    query.getSnapshot().refresh();
    await tick();
    assertEquals(selections.length, 2);
    assertEquals(query.getSnapshot().value, "restored");
    assertEquals(calls, 6);
    query.dispose();
    assertEquals(memory.subscriptions, 0);
  } finally {
    runtime.dispose();
  }
});

Deno.test("View boundaries isolate nested tracked reads, unchanged props, empty changes and removed children", async () => {
  const counts = { root: 0, a: 0, b: 0, detail: 0 };
  const boundaries = new Map<
    string,
    Pick<Observation<unknown>, "getSnapshot" | "subscribe">
  >();
  const runtime = await createBrowserRuntime({
    plugins: [local, {
      id: "views",
      views: {
        root: view("root", (_value, ctx) => {
          counts.root++;
          const selection = ctx.collections.local.get("b").value?.text;
          return [
            ctx.show({ shows: "a", value: { id: "a" } }),
            selection === "hidden"
              ? null
              : ctx.show({ shows: "b", value: { label: selection } }),
          ];
        }),
        a: view("a", (_value, ctx) => {
          counts.a++;
          return ctx.collections.local.get("a").value?.text;
        }),
        b: view("b", (value, ctx) => {
          counts.b++;
          return [value, ctx.show({ shows: "detail", value: null })];
        }),
        detail: view("detail", () => {
          counts.detail++;
          return "detail";
        }),
      },
    }],
    storage,
    renderer: {
      id: "fake",
      view(output, key) {
        boundaries.set(key, output);
        return { key, output };
      },
      mount() {
        return { dispose() {} };
      },
    },
  });
  try {
    const output = runtime.observe(() =>
      runtime.render({ shows: "root", value: null })
    );
    assertEquals(counts, { root: 1, a: 1, b: 1, detail: 1 });
    await runtime.actions.set({ id: "a", text: "typed" }).result();
    assertEquals(counts, { root: 1, a: 2, b: 1, detail: 1 });
    await runtime.actions.set({ id: "a", text: "typed" }).result();
    assertEquals(counts.a, 2, "identical visible read must not render");
    await runtime.actions.set({ id: "b", text: "new props" }).result();
    assertEquals(counts, { root: 2, a: 2, b: 2, detail: 1 });
    await runtime.actions.set({ id: "b", text: "hidden" }).result();
    assertEquals(counts, { root: 3, a: 2, b: 2, detail: 1 });
    const disposed = [...boundaries.values()].filter((boundary) => {
      try {
        boundary.getSnapshot();
        return false;
      } catch {
        return true;
      }
    });
    assertEquals(disposed.length, 2);
    output.dispose();
    for (const boundary of boundaries.values()) {
      let closed = false;
      try {
        boundary.getSnapshot();
      } catch {
        closed = true;
      }
      assert(closed);
    }
  } finally {
    runtime.dispose();
  }
});

Deno.test("nested View hints are explicit and navigation does not leak from parent", async () => {
  const hints: unknown[] = [], navigations: unknown[] = [];
  const runtime = await createBrowserRuntime({
    plugins: [{
      id: "hints",
      views: {
        parent: view(
          "parent",
          (
            _value,
            ctx,
          ) => [
            ctx.show({ shows: "child", value: null }),
            ctx.show({ shows: "child", value: null }, { pane: "own" }),
            ctx.show({ shows: "child", value: null }, {
              source: "link",
              region: "context",
            }),
          ],
        ),
        child: view("child", (_value, ctx) => {
          hints.push(ctx.hints);
          return "child";
        }),
      },
    }],
    renderer: {
      id: "fake",
      mount() {
        return { dispose() {} };
      },
    },
    show(reference, next) {
      navigations.push({ reference, hints: next });
    },
  });
  try {
    runtime.render({ shows: "parent", value: null }, {
      pane: "parent",
      region: "focus",
      source: "command",
      width: 900,
    });
    assertEquals(hints, [{ mode: "full", renderer: "fake" }, {
      pane: "own",
      mode: "full",
      renderer: "fake",
    }]);
    assertEquals(navigations, [{
      reference: { shows: "child", value: null },
      hints: { source: "link", region: "context" },
    }]);
  } finally {
    runtime.dispose();
  }
});

Deno.test("browser Actions batch persistence across awaits and flush applied mutations on failure", async () => {
  const saved: unknown[] = [];
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const plugin: BrowserPlugin = {
    ...local,
    actions: {
      ...local.actions,
      batch: {
        id: "batch",
        placement: "browser",
        async execute(_input, ctx) {
          ctx.command("local", "a", "set", "one");
          await pause;
          ctx.command("local", "a", "set", "two");
          ctx.command("local", "b", "set", "three");
        },
      },
      fail: {
        id: "fail",
        placement: "browser",
        execute(_input, ctx) {
          ctx.command("local", "a", "set", "applied");
          throw new Error("failed");
        },
      },
    },
  };
  const runtime = await createBrowserRuntime({
    plugins: [plugin],
    storage: {
      disk: {
        load: () => undefined,
        save(_key, rows) {
          saved.push(rows);
        },
      },
    },
  });
  try {
    const action = runtime.actions.batch({});
    await tick();
    assertEquals(saved.length, 0);
    await runtime.actions.set({ id: "b", text: "overlap" }).result();
    await runtime.flushStorage();
    assertEquals(saved.length, 1);
    resume();
    await action.result();
    await runtime.flushStorage();
    assertEquals(saved.length, 2);
    assertEquals(saved[1], [{ id: "a", text: "two" }, {
      id: "b",
      text: "three",
    }]);
    await assertRejects(
      () => runtime.actions.fail({}).result(),
      Error,
      "failed",
    );
    await runtime.flushStorage();
    assertEquals(saved.length, 3);
    assertEquals((saved[2] as { text: string }[])[0].text, "applied");
  } finally {
    resume();
    runtime.dispose();
  }
});

Deno.test("URL popstate restores stored Collections, notifies readers, never saves back and unsubscribes", async () => {
  let url = new URL("https://app.example/");
  let saves = 0;
  const errors: unknown[] = [];
  const events = new EventTarget();
  const adapter = urlStorageAdapter({
    read: () => url,
    replace(next) {
      url = next;
      saves++;
    },
    events,
  });
  const runtime = await createBrowserRuntime({
    plugins: [local],
    storage: { disk: adapter },
    onError: (error) => errors.push(error),
  });
  const read = runtime.observe((ctx) => ctx.collections.local.get("a"));
  const navigate = (text: string) => {
    url = new URL("https://app.example/");
    url.searchParams.set(
      "workspace.local",
      JSON.stringify([{ id: "a", text }]),
    );
    events.dispatchEvent(new Event("popstate"));
  };
  try {
    await runtime.actions.set({ id: "a", text: "saved" }).result();
    await runtime.flushStorage();
    assertEquals(saves, 1);
    navigate("back");
    await tick();
    assertEquals(read.getSnapshot().value?.text, "back");
    assertEquals(saves, 1);
    navigate("forward");
    await tick();
    assertEquals(read.getSnapshot().value?.text, "forward");
    url = new URL("https://app.example/");
    events.dispatchEvent(new Event("popstate"));
    await tick();
    assertEquals(read.getSnapshot().value?.text, "first");
    await runtime.restoreStorage();
    assertEquals(saves, 1);
  } finally {
    runtime.dispose();
  }
  navigate("disposed");
  await tick();
  assertEquals(saves, 1);
  assertEquals(errors, [], "disposed runtime removes popstate listeners");
});

Deno.test("storage restore fences older loads, queued saves and intervening local commands", async () => {
  const loads: ((value: readonly { id: string; text: string }[]) => void)[] =
    [];
  let initial = true, saved = 0, changed!: () => void;
  const runtime = await createBrowserRuntime({
    plugins: [local],
    storage: {
      disk: {
        load() {
          if (initial) {
            initial = false;
            return undefined;
          }
          return new Promise((resolve) => loads.push(resolve));
        },
        save() {
          saved++;
        },
        subscribe(listener) {
          changed = listener;
          return () => {};
        },
      },
    },
  });
  try {
    const first = runtime.restoreStorage(), second = runtime.restoreStorage();
    loads[1]([{ id: "a", text: "latest" }]);
    await second;
    loads[0]([{ id: "a", text: "old" }]);
    await first;
    assertEquals(runtime.collections.local.get("a").value?.text, "latest");
    const third = runtime.restoreStorage();
    await runtime.actions.set({ id: "a", text: "local" }).result();
    loads[2]([{ id: "a", text: "late" }]);
    await third;
    assertEquals(runtime.collections.local.get("a").value?.text, "local");
    await runtime.flushStorage();
    const before = saved;
    // External navigation wins over a save queued by the just-completed Action.
    runtime.onEvent((event) => {
      if (event.type === "action.completed") changed();
    });
    await runtime.actions.set({ id: "a", text: "queued" }).result();
    loads[3]([{ id: "a", text: "navigation" }]);
    await tick();
    await runtime.flushStorage();
    assertEquals(saved, before);
    assertEquals(runtime.collections.local.get("a").value?.text, "navigation");
  } finally {
    runtime.dispose();
  }
});

Deno.test("query dependency outage is unavailable with refresh, never silently ready", async () => {
  const memory = new MemorySubscriptions();
  let calls = 0;
  const runtime = await createBrowserRuntime({
    plugins: [{
      id: "query",
      collections: { entry: { placement: "server" } },
      actions: {
        total: {
          id: "total",
          placement: "server",
          query: { reads: ["entry"] },
        },
      },
    }],
    live: memory,
    actions: {
      invoke() {
        calls++;
        return Promise.resolve({ value: 1, seq: "1" });
      },
      async cancel() {},
    },
  });
  try {
    const query = runtime.observe((ctx) => ctx.readAction("total", {}));
    await tick();
    const dependency = { collection: "entry", progressOnly: true };
    await memory.publish(dependency, {
      t: "snapshot",
      rows: [],
      sequence: "1",
      checkpoint: "one",
      complete: true,
    });
    await memory.fail(dependency);
    // Its live dependency reconnecting keeps the query stale, not failed.
    assertEquals(query.getSnapshot().error?.kind, "unavailable");
    assertEquals(query.getSnapshot().status, "stale");
    query.getSnapshot().refresh();
    await tick();
    await memory.publish(dependency, {
      t: "snapshot",
      rows: [],
      sequence: "2",
      checkpoint: "two",
      complete: true,
    });
    assertEquals(query.getSnapshot().status, "ready");
    assertEquals(query.getSnapshot().error, undefined);
    assertEquals(calls, 2);
  } finally {
    runtime.dispose();
  }
});
