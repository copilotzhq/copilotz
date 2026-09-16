import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { defineAction } from "../actions/define.ts";
import { contribution, createPluginRegistry, definePlugin } from "./index.ts";

const execute = defineAction({ id: "example.execute", execute: () => "ok" });
const declaration = {
  [contribution]({ alias }: { alias: string }) {
    return { value: { action: alias }, actions: { [alias]: execute } };
  },
};

Deno.test("generic contributions expand once without mutating reusable declarations", () => {
  const resources = { example: { run: declaration } };
  const plugin = definePlugin({ id: "example", version: "1", resources });
  assertStrictEquals(plugin.actions.run, execute);
  assertEquals(plugin.resources.example.run, { action: "run" });
  assertStrictEquals(resources.example.run, declaration);
  const registry = createPluginRegistry({ resources });
  assertStrictEquals(registry.actions.run, execute);
  assertEquals(registry.resources.example.run, { action: "run" });
});

Deno.test("root resources override dependencies without changing another app", () => {
  const defaults = definePlugin({
    id: "base",
    version: "1",
    resources: { policy: { config: { limit: 10 } } },
  });
  const first = createPluginRegistry({
    plugins: [defaults],
    resources: { policy: { config: { limit: 2 } } },
  });
  const second = createPluginRegistry({ plugins: [defaults] });
  assertEquals(first.resources.policy.config.limit, 2);
  assertEquals(second.resources.policy.config.limit, 10);
});

Deno.test("contribution collisions and asynchronous expansion fail before execution", () => {
  assertThrows(
    () =>
      definePlugin({
        id: "bad",
        version: "1",
        actions: { run: execute },
        resources: { example: { run: declaration } },
      }),
    TypeError,
    "conflicts",
  );
  assertThrows(
    () =>
      definePlugin({
        id: "bad",
        version: "1",
        resources: {
          example: {
            run: {
              async [contribution]() {
                return { value: 1 };
              },
            },
          },
        },
      }),
    TypeError,
    "synchronously",
  );
});

Deno.test("contributions reject unsafe namespaces and nested declarations", () => {
  for (
    const resources of [
      { constructor: { bad: 1 } },
      { example: { nested: declaration } },
    ]
  ) {
    assertThrows(() =>
      definePlugin({
        id: "invalid",
        version: "1",
        resources: {
          example: {
            run: {
              [contribution]() {
                return { value: 1, resources };
              },
            },
          },
        },
      }), TypeError);
  }
});
