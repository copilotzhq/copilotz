import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createTextRenderer,
  createViewResolver,
  defineView,
  snapshotViewData,
  type ViewContext,
} from "./index.ts";

const reference = { shows: "note", value: null };
const noViews = { resolveView: createViewResolver({}) };
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
