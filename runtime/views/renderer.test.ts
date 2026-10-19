import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createTextRenderer,
  createViewResolver,
  defineView,
  snapshotViewData,
  type TextRendererOptions,
  type ViewContext,
} from "./index.ts";

const reference = { shows: "note", value: null };
const noViews = { resolveView: createViewResolver({}) };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const view = (render: (value: unknown, context: ViewContext) => unknown) => ({
  resolveView: createViewResolver({
    note: defineView({
      id: "note.text",
      shows: "note",
      modes: ["context"],
      renderer: "text",
      render,
    }),
  }),
});

Deno.test("View snapshots bound depth nodes UTF-8 bytes and sparse allocations without getters", () => {
  assertThrows(
    () => snapshotViewData({ a: { b: {} } }, { maxDepth: 1 }),
    RangeError,
    "depth",
  );
  assertThrows(
    () => snapshotViewData([1, 2, 3], { maxNodes: 3 }),
    RangeError,
    "node",
  );
  assertThrows(
    () => snapshotViewData("🌲🌲", { maxBytes: 8 }),
    RangeError,
    "byte",
  );
  assertThrows(
    () => snapshotViewData(new Array(1_000_000)),
    RangeError,
    "node",
  );
  assertThrows(() => snapshotViewData(new Array(2)), TypeError, "dense");
  let getters = 0;
  assertThrows(
    () =>
      snapshotViewData({
        get value() {
          getters++;
          return "secret";
        },
      }),
    TypeError,
    "Unsafe",
  );
  assertEquals(getters, 0);
});

Deno.test("View renderer rejects invalid resource bounds before invoking callbacks", () => {
  for (
    const name of [
      "maxDepth",
      "maxNodes",
      "maxBytes",
      "maxPending",
      "timeoutMs",
    ] as const
  ) {
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      assertThrows(
        () =>
          createTextRenderer({
            registry: noViews,
            scope: {},
            project: () => null,
            [name]: value,
          }),
        TypeError,
        "bound",
      );
    }
  }
});

Deno.test("timed-out projection holds admission until its actual promise settles", async () => {
  const held = Promise.withResolvers<unknown>();
  let calls = 0;
  const renderer = createTextRenderer({
    registry: noViews,
    scope: {},
    maxPending: 1,
    timeoutMs: 10,
    project() {
      return ++calls === 1 ? held.promise : "ready";
    },
  });
  await assertRejects(() => renderer.render(reference), Error, "timed out");
  await assertRejects(() => renderer.render(reference), RangeError, "capacity");
  assertEquals(calls, 1);
  held.resolve("late");
  await tick();
  assertEquals(await renderer.render(reference), "ready");
});

Deno.test("aborted noncooperative View retains its slot and revokes captured capabilities", async () => {
  const held = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  let captured!: ViewContext;
  let calls = 0;
  const renderer = createTextRenderer({
    registry: view((_value, context) => {
      calls++;
      captured = context;
      started.resolve();
      return calls === 1 ? held.promise : "ready";
    }),
    scope: {},
    project: () => null,
    maxPending: 1,
  });
  const controller = new AbortController();
  const rendering = renderer.render(reference, {}, controller.signal);
  await started.promise;
  controller.abort(new Error("cancelled"));
  await assertRejects(() => rendering, Error, "cancelled");
  assertEquals(captured.signal.aborted, true);
  await assertRejects(() => captured.show(reference), Error, "cancelled");
  await assertRejects(() => renderer.render(reference), RangeError, "capacity");
  held.resolve("late");
  await tick();
  assertEquals(await renderer.render(reference), "ready");
});

Deno.test("adapter cannot free a still-running detached View evaluation", async () => {
  const held = Promise.withResolvers<string>();
  let calls = 0;
  const renderer = createTextRenderer({
    registry: view(() => {
      calls++;
      return held.promise;
    }),
    scope: {},
    project: () => null,
    maxPending: 1,
    renderers: {
      text: {
        open: () => ({
          render(evaluate) {
            void evaluate();
            return "adapter result";
          },
        }),
      },
    },
  });
  assertEquals(await renderer.render(reference), "adapter result");
  await assertRejects(() => renderer.render(reference), RangeError, "capacity");
  assertEquals(calls, 1);
  held.resolve("late");
  await tick();
  assertEquals(await renderer.render(reference), "adapter result");
  await tick();
});

Deno.test("held adapter and cleanup promises remain charged after the common deadline", async () => {
  for (const phase of ["render", "dispose"] as const) {
    const held = Promise.withResolvers<string>();
    let calls = 0;
    const renderer = createTextRenderer({
      registry: noViews,
      scope: {},
      project: () => null,
      maxPending: 1,
      timeoutMs: 10,
      renderers: {
        text: {
          open: () => ({
            render() {
              calls++;
              return phase === "render" && calls === 1 ? held.promise : "ready";
            },
            dispose() {
              return phase === "dispose" && calls === 1
                ? held.promise.then(() => {})
                : undefined;
            },
          }),
        },
      },
    });
    await assertRejects(() => renderer.render(reference), Error, "timed out");
    await assertRejects(
      () => renderer.render(reference),
      RangeError,
      "capacity",
    );
    held.resolve("late");
    await tick();
    assertEquals(await renderer.render(reference), "ready");
  }
});

Deno.test("nested rendering reserves capacity synchronously without dispatching excess callbacks", async () => {
  const held = Promise.withResolvers<string>();
  let childProjects = 0;
  const childStarted = Promise.withResolvers<void>();
  const rejected = Promise.withResolvers<void>();
  const parent = defineView({
    id: "parent.text",
    shows: "parent",
    renderer: "text",
    modes: ["context"],
    async render(_value, context) {
      const child = context.show(reference);
      await assertRejects(
        () => context.show(reference),
        RangeError,
        "capacity",
      );
      rejected.resolve();
      return await child;
    },
  });
  const renderer = createTextRenderer({
    registry: { resolveView: createViewResolver({ parent }) },
    scope: {},
    maxPending: 2,
    project(ref) {
      if (ref.shows === "note") {
        childProjects++;
        childStarted.resolve();
        return held.promise;
      }
      return null;
    },
  });
  const rendering = renderer.render({ shows: "parent", value: null });
  await childStarted.promise;
  await rejected.promise;
  assertEquals(childProjects, 1);
  held.resolve("child");
  assertEquals(await rendering, "child");
});

Deno.test("nested sequential renders share cumulative node and byte budgets", async () => {
  for (const limits of [{ maxNodes: 25 }, { maxBytes: 250 }]) {
    let calls = 0;
    const renderer = createTextRenderer({
      ...limits,
      registry: view(async (_value, context) => {
        for (let i = 0; i < 100; i++) {
          await context.show({ shows: "other", value: null });
        }
        return "done";
      }),
      scope: {},
      project() {
        calls++;
        return "value";
      },
    });
    await assertRejects(() => renderer.render(reference), RangeError, "limit");
    assertEquals(calls < 100, true);
  }
});

Deno.test("View projection output adapter output and collection results share enforced bounds", async () => {
  const oversized = "x".repeat(500);
  const cases: Partial<TextRendererOptions>[] = [
    { project: () => oversized },
    { registry: view(() => oversized) },
    { renderers: { text: { open: () => ({ render: () => oversized }) } } },
    {
      registry: view(async (_value, context) =>
        (await context.collections.notes.get({})).value
      ),
      collections: {
        notes: {
          get: () =>
            Promise.resolve({
              value: oversized,
              status: "ready",
              pending: false,
            }),
          list: () =>
            Promise.resolve({ value: [], status: "ready", pending: false }),
        },
      },
    },
  ];
  for (const changes of cases) {
    const renderer = createTextRenderer({
      registry: noViews,
      scope: {},
      project: () => null,
      maxBytes: 200,
      ...changes,
    });
    await assertRejects(() => renderer.render(reference), RangeError, "byte");
  }
});

Deno.test("pending collection callbacks retain capacity after a View returns", async () => {
  const held = Promise.withResolvers<
    { value: null; status: "missing"; pending: false }
  >();
  let reads = 0;
  const renderer = createTextRenderer({
    registry: view((_value, context) => {
      void context.collections.notes.get({}).catch(() => {});
      return "done";
    }),
    scope: {},
    project: () => null,
    maxPending: 2,
    collections: {
      notes: {
        get() {
          reads++;
          return held.promise;
        },
        list: () => held.promise,
      },
    },
  });
  assertEquals(await renderer.render(reference), "done");
  await assertRejects(() => renderer.render(reference), RangeError, "capacity");
  assertEquals(reads, 1);
  held.resolve({ value: null, status: "missing", pending: false });
  await tick();
  assertEquals(await renderer.render(reference), "done");
  await tick();
});

Deno.test("selectors nested hints and output accessors are rejected without evaluation", async () => {
  let getters = 0;
  const accessor = {
    get mode() {
      getters++;
      return "context";
    },
  };
  const renderer = createTextRenderer({
    registry: noViews,
    scope: {},
    project: () => null,
  });
  await assertRejects(
    () =>
      renderer.render({
        get shows() {
          getters++;
          return "note";
        },
        value: null,
      }),
    TypeError,
    "Unsafe",
  );
  await assertRejects(
    () => renderer.render(reference, accessor),
    TypeError,
    "Unsafe",
  );
  const nested = createTextRenderer({
    registry: view((_value, context) => context.show(reference, accessor)),
    scope: {},
    project: () => null,
  });
  await assertRejects(() => nested.render(reference), TypeError, "Unsafe");
  const output = createTextRenderer({
    registry: view(() => ({
      get value() {
        getters++;
        return "secret";
      },
    })),
    scope: {},
    project: () => null,
  });
  await assertRejects(() => output.render(reference), TypeError, "Unsafe");
  assertEquals(getters, 0);
});

Deno.test("timed-out actual View promise cannot reclaim admission until settlement", async () => {
  const held = Promise.withResolvers<string>();
  let calls = 0;
  let captured!: ViewContext;
  const renderer = createTextRenderer({
    registry: view((_value, context) => {
      captured = context;
      return ++calls === 1 ? held.promise : "ready";
    }),
    scope: {},
    project: () => null,
    maxPending: 1,
    timeoutMs: 10,
  });
  await assertRejects(() => renderer.render(reference), Error, "timed out");
  assertEquals(captured.signal.aborted, true);
  await assertRejects(() => renderer.render(reference), RangeError, "capacity");
  assertEquals(calls, 1);
  held.resolve("late");
  await tick();
  assertEquals(await renderer.render(reference), "ready");
});

Deno.test("detached nested work shares the root deadline and retains its own physical slot", async () => {
  const held = Promise.withResolvers<unknown>();
  let childSignal: AbortSignal | undefined;
  let nested = true;
  const renderer = createTextRenderer({
    registry: view(async (_value, context) => {
      if (nested) return await context.show({ shows: "child", value: null });
      return "ready";
    }),
    scope: {},
    maxPending: 2,
    timeoutMs: 10,
    project(ref, context) {
      if (ref.shows === "child") {
        childSignal = context.signal;
        return held.promise;
      }
      return null;
    },
  });
  await assertRejects(() => renderer.render(reference), Error, "timed out");
  assertEquals(childSignal?.aborted, true);
  // The ended parent slot is free, but the physical child keeps the other slot.
  await assertRejects(() => renderer.render(reference), RangeError, "capacity");
  held.resolve(null);
  await tick();
  nested = false;
  assertEquals(await renderer.render(reference), "ready");
});
