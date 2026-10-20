import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTextRenderer,
  createViewResolver,
  defineView,
  isViewDefinition,
  snapshotViewData,
  type ViewContext,
  type ViewShows,
} from "./index.ts";
const basic = (
  id = "board.text",
  shows: ViewShows = "board",
  modes = ["context"],
) =>
  defineView({
    id,
    shows,
    modes,
    renderer: "text",
    render: (item: { title: string }) => item.title,
  });
const registry = (views = { board: basic() }) => ({
  resolveView: createViewResolver(views),
});

test("View definitions validate, snapshot metadata and preserve input/output inference", () => {
  const modes = ["context"];
  const shows = { list: "board" };
  const view = defineView({
    id: "board.list",
    modes,
    shows,
    renderer: "text",
    render: (value: number, ctx) => {
      const typed: ViewContext = ctx;
      void typed;
      return value + 1;
    },
  });
  const output: number | Promise<number> = view.render(1, {} as ViewContext);
  assert.equal(output, 2);
  modes.push("page");
  shows.list = "other";
  assert.deepEqual(view.modes, ["context"]);
  assert.equal((view.shows as { list: string }).list, "board");
  assert.notEqual(view, undefined);
  for (
    const invalid of [
      { id: "" },
      { id: " spaced " },
      { shows: {} },
      { shows: { list: "board", action: "x" } },
      { shows: { navigation: "" } },
      { modes: [] },
      { modes: ["context", "context"] },
      { renderer: "" },
      { render: null },
      { surprise: true },
    ]
  ) {
    assert.equal(isViewDefinition({ ...basic(), ...invalid }), false);
    assert.throws(
      () => defineView({ ...basic(), ...invalid } as never),
      TypeError,
    );
  }
});

test("resolution distinguishes all reference forms, open modes and renderer", () => {
  const kinds: ViewShows[] = ["board", { list: "board" }, { action: "board" }, {
    navigation: "board",
  }, "namedDatum"];
  const views = Object.fromEntries(
    kinds.map((
      shows,
      i,
    ) => [`v${i}`, basic(`view.${i}`, shows, ["custom-mode"])]),
  );
  const resolve = createViewResolver(views);
  kinds.forEach((shows, i) =>
    assert.equal(resolve(shows, "custom-mode", "text")?.id, `view.${i}`)
  );
  assert.equal(resolve("board", "context", "text"), undefined);
  assert.equal(resolve("board", "custom-mode", "email"), undefined);
});

test("overlap requires valid exact candidate preference and never overrides executable IDs", () => {
  const first = basic("first", "board", ["context", "panel"]);
  const second = basic("second", "board", ["context"]);
  assert.throws(() => createViewResolver({ first, second }), /Ambiguous/);
  const preference = [{
    shows: "board",
    mode: "context",
    renderer: "text",
    view: "second",
  }];
  const resolve = createViewResolver({ first, second }, preference);
  assert.equal(resolve("board", "context", "text"), second);
  assert.equal(resolve("board", "panel", "text"), first);
  for (
    const invalid of [{}, [{ ...preference[0], view: "missing" }], [{
      ...preference[0],
      mode: "page",
    }], [...preference, ...preference]]
  ) {
    assert.throws(
      () => createViewResolver({ first, second }, invalid),
      TypeError,
    );
  }
  assert.throws(
    () => createViewResolver({ first, duplicate: first }, preference),
    /Duplicate View id/,
  );
});

test("projected inputs and generic fallback never receive hidden raw fields", async () => {
  const raw = { title: "Visible", secret: "hidden", protected: "private" };
  let projections = 0;
  const renderer = createTextRenderer({
    registry: registry(),
    scope: { principal: "agent" },
    project: () => {
      projections++;
      return { title: raw.title };
    },
  });
  assert.equal(
    await renderer.render({ shows: "board", value: raw }),
    "Visible",
  );
  assert.equal(
    await renderer.render({ shows: "unknown", value: raw }),
    '{"title":"Visible"}',
  );
  assert.equal(projections, 2);
  assert.throws(
    () =>
      createTextRenderer(
        { registry: registry(), scope: {}, project: undefined } as never,
      ),
    /projection/,
  );
  let getter = 0;
  assert.throws(() =>
    snapshotViewData({
      get secret() {
        getter++;
        return "hidden";
      },
    }), /Unsafe/);
  assert.equal(getter, 0);
  for (const unsafe of [() => 1, new Date(), { adapter: () => 1 }, Infinity]) {
    assert.throws(() => snapshotViewData(unsafe));
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => snapshotViewData(cycle), /acyclic/);
});

test("restricted runtime ctx has read-only collections, no adapters, no pure Action effects", async () => {
  let calls = 0;
  const collection = {
    get: () =>
      Promise.resolve({
        value: { title: "Safe" },
        status: "ready" as const,
        pending: false,
      }),
    list: () =>
      Promise.resolve({ value: [], status: "ready" as const, pending: false }),
    insert() {
      calls++;
    },
    subscribe() {
      calls++;
    },
  };
  const view = defineView({
    id: "restricted",
    shows: "board",
    renderer: "text",
    modes: ["context"],
    async render(_item, ctx) {
      assert.deepEqual(Object.keys(ctx).sort(), [
        "actions",
        "collections",
        "hints",
        "resources",
        "scope",
        "show",
        "signal",
      ]);
      assert.deepEqual(Object.keys(ctx.collections.boards).sort(), [
        "get",
        "list",
      ]);
      assert.equal("adapters" in ctx, false);
      assert.equal("transaction" in ctx, false);
      assert.throws(() => ctx.actions.mutate({}), /unavailable/);
      const read = await ctx.collections.boards.get({});
      assert.notEqual(read.value, undefined);
      return (read.value as { title: string }).title;
    },
  });
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ view }) },
    scope: {},
    collections: { boards: collection },
    actions: {
      mutate() {
        calls++;
      },
    },
    project: () => ({}),
  });
  assert.equal(await renderer.render({ shows: "board", value: null }), "Safe");
  assert.equal(calls, 0);
});

test("same and cross-renderer nesting preserve viewer scope, lifetime and mode", async () => {
  const seen: unknown[] = [];
  const parent = defineView({
    id: "parent",
    shows: "parent",
    renderer: "text",
    modes: ["context"],
    async render(_item, ctx) {
      seen.push(ctx.scope);
      return await ctx.show({ shows: "child", value: null }) +
        await ctx.show({ shows: "child", value: null }, { renderer: "email" });
    },
  });
  const child = (renderer: string) =>
    defineView({
      id: `child.${renderer}`,
      shows: "child",
      renderer,
      modes: ["context"],
      render(_item, ctx) {
        seen.push(ctx.scope);
        assert.equal(ctx.hints.mode, "context");
        return renderer;
      },
    });
  let opens = 0, cleanups = 0;
  const renderer = createTextRenderer({
    registry: {
      resolveView: createViewResolver({
        parent,
        child: child("text"),
        email: child("email"),
      }),
    },
    scope: { principal: "viewer" },
    project: () => ({}),
    renderers: {
      email: {
        open({ scope }) {
          seen.push(scope);
          opens++;
          return {
            render: async (evaluate) => `[${await evaluate()}]`,
            dispose() {
              cleanups++;
            },
          };
        },
      },
    },
  });
  assert.equal(
    await renderer.render({ shows: "parent", value: null }),
    "text[email]",
  );
  for (const scope of seen) assert.deepEqual(scope, seen[0]);
  assert.equal(opens, 1);
  assert.equal(cleanups, 1);
  await assert.rejects(
    renderer.render({ shows: "child", value: null }, { renderer: "missing" }),
    /No one-shot/,
  );
});

test("one-shot renderer cleans up on success, rejection and abort without tracking", async () => {
  let cleanups = 0, evaluations = 0;
  let fail = false, hang = false;
  const view = defineView({
    id: "once",
    shows: "board",
    modes: ["context"],
    renderer: "text",
    render() {
      evaluations++;
      if (fail) throw new Error("failed");
      if (hang) return new Promise<string>(() => {});
      return "done";
    },
  });
  let opened!: () => void;
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ view }) },
    scope: {},
    project: () => ({}),
    renderers: {
      text: {
        open() {
          opened?.();
          return {
            render: async (evaluate) => String(await evaluate()),
            dispose() {
              cleanups++;
            },
          };
        },
      },
    },
  });
  assert.equal(await renderer.render({ shows: "board", value: null }), "done");
  fail = true;
  await assert.rejects(
    renderer.render({ shows: "board", value: null }),
    /failed/,
  );
  fail = false;
  hang = true;
  const controller = new AbortController();
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const pending = renderer.render(
    { shows: "board", value: null },
    {},
    controller.signal,
  );
  await started;
  await Promise.resolve();
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(cleanups, 3);
  assert.equal(evaluations, 3);
  await assert.rejects(
    renderer.render({ shows: "board", value: null }, {}, controller.signal),
    /cancelled/,
  );
  assert.equal(cleanups, 3);
});

test("one-shot renderer cannot re-evaluate", async () => {
  const twice = createTextRenderer({
    registry: registry(),
    scope: {},
    project: () => ({ title: "safe" }),
    renderers: {
      text: {
        open: () => ({
          async render(evaluate) {
            await evaluate();
            await evaluate();
            return "";
          },
        }),
      },
    },
  });
  await assert.rejects(
    twice.render({ shows: "board", value: null }),
    /cannot evaluate twice/,
  );
});

// Compile-time capability regression: these remain errors even for authored Views.
function typeBoundary(ctx: ViewContext) {
  // @ts-expect-error Views cannot use adapters.
  ctx.adapters;
  // @ts-expect-error Views cannot mutate collections directly.
  ctx.collections.boards.insert({});
  // @ts-expect-error Views cannot access transactions.
  ctx.transaction;
  // @ts-expect-error One-shot reads cannot subscribe.
  ctx.collections.boards.subscribe(() => {});
}
void typeBoundary;

test("captured View contexts lose read and nesting access when rendering ends", async () => {
  let captured!: ViewContext;
  let reads = 0;
  const view = defineView({
    id: "capture",
    shows: "board",
    renderer: "text",
    modes: ["context"],
    render(_item, ctx) {
      captured = ctx;
      return "done";
    },
  });
  const read = () => {
    reads++;
    return Promise.resolve({
      value: null,
      status: "missing" as const,
      pending: false,
    });
  };
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ view }) },
    scope: {},
    project: () => ({}),
    collections: { board: { get: read, list: read } },
  });
  await renderer.render({ shows: "board", value: null });
  assert.equal(captured.signal.aborted, true);
  await assert.rejects(captured.collections.board.get({}), /lifetime ended/);
  await assert.rejects(
    captured.show({ shows: "board", value: null }),
    /lifetime ended/,
  );
  assert.equal(reads, 0);
});

test("nested contexts are revoked before their session is disposed", async () => {
  let childContext!: ViewContext;
  let reads = 0;
  const child = defineView({
    id: "child",
    shows: "child",
    renderer: "text",
    modes: ["context"],
    render(_item, ctx) {
      childContext = ctx;
      return "child";
    },
  });
  const parent = defineView({
    id: "parent",
    shows: "parent",
    renderer: "text",
    modes: ["context"],
    async render(_item, ctx) {
      await ctx.show({ shows: "child", value: null });
      assert.equal(childContext.signal.aborted, true);
      await assert.rejects(
        childContext.collections.board.get({}),
        /lifetime ended/,
      );
      return "parent";
    },
  });
  const read = () => {
    reads++;
    return Promise.resolve({
      value: null,
      status: "missing" as const,
      pending: false,
    });
  };
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ child, parent }) },
    scope: {},
    project: () => ({}),
    collections: { board: { get: read, list: read } },
    renderers: {
      text: {
        open({ signal }) {
          return {
            render: async (evaluate) => String(await evaluate()),
            dispose() {
              assert.equal(signal.aborted, true);
            },
          };
        },
      },
    },
  });
  assert.equal(
    await renderer.render({ shows: "parent", value: null }),
    "parent",
  );
  assert.equal(reads, 0);
});

test("definition validation rejects inherited executable methods rather than losing them during snapshot", () => {
  class InheritedView {
    id = "inherited";
    shows = "board";
    renderer = "text";
    modes = ["context"];
    render() {
      return "hidden on prototype";
    }
  }
  assert.equal(isViewDefinition(new InheritedView()), false);
  assert.throws(() => defineView(new InheritedView()), /Invalid/);
});

test("mutating a local scope snapshot cannot widen nested projection authority", async () => {
  const scopes: unknown[] = [];
  const parent = defineView({
    id: "parent.scope",
    shows: "parent",
    modes: ["context"],
    renderer: "text",
    async render(_item, ctx) {
      try {
        (ctx.scope as { role: string }).role = "admin";
      } catch { /* A host may freeze its own snapshots. */ }
      return await ctx.show({ shows: "child", value: null });
    },
  });
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ parent }) },
    scope: { role: "viewer" },
    project(_ref, { scope }) {
      scopes.push((scope as { role: string }).role);
      return "safe";
    },
  });
  assert.equal(await renderer.render({ shows: "parent", value: null }), "safe");
  assert.deepEqual(scopes, ["viewer", "viewer"]);
});

test("local View snapshots cannot mutate host data or inherited nested hints", async () => {
  const original = { title: "Host title", nested: { count: 1 } };
  const resource = { labels: { title: "Host label" } };
  const child = defineView({
    id: "child.hints",
    shows: "child",
    renderer: "text",
    modes: ["context"],
    render(_item, ctx) {
      return ctx.hints.renderer;
    },
  });
  const parent = defineView({
    id: "parent.hints",
    shows: "parent",
    renderer: "text",
    modes: ["context"],
    async render(item: typeof original, ctx) {
      item.title = "Local title";
      item.nested.count = 9;
      (ctx.resources.labels as { title: string }).title = "Local label";
      (ctx.hints as { renderer: string }).renderer = "email";
      return await ctx.show({ shows: "child", value: null });
    },
  });
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ parent, child }) },
    scope: {},
    resources: resource,
    project: () => original,
  });
  assert.equal(await renderer.render({ shows: "parent", value: null }), "text");
  assert.deepEqual(original, { title: "Host title", nested: { count: 1 } });
  assert.equal(resource.labels.title, "Host label");
});

test("tampering with an exposed signal cannot revive expired read or nesting access", async () => {
  let captured!: ViewContext;
  let reads = 0;
  let projections = 0;
  const view = defineView({
    id: "signal.capture",
    shows: "board",
    renderer: "text",
    modes: ["context"],
    render(_item, ctx) {
      captured = ctx;
      return "done";
    },
  });
  const read = () => {
    reads++;
    return Promise.resolve({
      value: null,
      status: "missing" as const,
      pending: false,
    });
  };
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ view }) },
    scope: {},
    project: () => {
      projections++;
      return {};
    },
    collections: { board: { get: read, list: read } },
  });
  await renderer.render({ shows: "board", value: null });
  Object.defineProperty(captured.signal, "aborted", { value: false });
  captured.signal.throwIfAborted = () => {};
  await assert.rejects(captured.collections.board.get(null), /lifetime ended/);
  await assert.rejects(
    captured.show({ shows: "board", value: null }),
    /lifetime ended/,
  );
  assert.equal(reads, 0);
  assert.equal(projections, 1);
});
