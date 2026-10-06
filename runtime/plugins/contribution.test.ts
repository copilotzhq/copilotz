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

Deno.test("contributed dependencies compose once and propagate their inferred namespace types", () => {
  const dependency = definePlugin({
    id: "resource-support",
    version: "1",
    actions: { run: execute },
    resources: { policy: { config: { limit: 10 as const } } },
    adapters: { remote: { default: { endpoint: "default" } } },
  });
  const resource = {
    [contribution]() {
      return { value: { name: "declared" }, plugins: [dependency] as const };
    },
  };
  const first = definePlugin({
    id: "first",
    version: "1",
    resources: { example: { declared: resource } },
  });
  const second = definePlugin({
    id: "second",
    version: "1",
    resources: { example: { declared: resource } },
  });
  const registry = createPluginRegistry({
    plugins: [first, second],
    adapters: { remote: { default: { endpoint: "override" } } },
  });
  const typed: 10 = registry.resources.policy.config.limit;
  assertEquals(typed, 10);
  assertStrictEquals(registry.actions.run, execute);
  assertEquals(registry.adapters.remote.default.endpoint, "override");
  assertEquals(
    registry.plugins.filter((plugin) => plugin.id === dependency.id).length,
    1,
  );
  assertThrows(
    () =>
      definePlugin({
        id: "invalid",
        version: "1",
        resources: {
          example: {
            invalid: {
              [contribution]() {
                return { value: 1, plugins: [{}] };
              },
            },
          },
        },
      }),
    TypeError,
    "definePlugin",
  );
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

Deno.test("root contributions preserve explicitly declared plugin Actions and resources", () => {
  const app = definePlugin({
    id: "app",
    version: "1",
    actions: { explicit: execute },
    resources: { agents: { assistant: { role: "helper" as const } } },
  });
  const dependency = definePlugin({
    id: "support",
    version: "1",
    actions: {
      contributed: defineAction({
        id: "contribution.other",
        execute: () => "other",
      }),
    },
  });
  const resource = {
    [contribution]() {
      return { value: {}, plugins: [dependency] as const };
    },
  };
  const registry = createPluginRegistry({
    plugins: [app],
    resources: { example: { declared: resource } },
  });
  const role: "helper" = registry.resources.agents.assistant.role;
  assertEquals(role, "helper");
  assertStrictEquals(registry.actions.explicit, execute);
  assertStrictEquals(
    registry.actions.contributed,
    dependency.actions.contributed,
  );
});

Deno.test("Skills at the root preserve Core and application type inference", async () => {
  const { corePlugin } = await import("../../plugins/core/plugin.ts");
  const { defineSkill } = await import("../../plugins/skills/index.ts");
  const app = definePlugin({
    id: "typed-app",
    version: "1",
    actions: { appAction: execute },
    resources: { agents: { assistant: { role: "helper" as const } } },
  });
  const registry = createPluginRegistry({
    plugins: [corePlugin, app],
    resources: {
      skills: {
        planning: defineSkill({ root: "https://skills.test/planning/" }),
      },
    },
  });
  const role: "helper" = registry.resources.agents.assistant.role;
  assertEquals(role, "helper");
  assertStrictEquals(registry.actions.appAction, execute);
  assertStrictEquals(registry.actions.ask, corePlugin.actions.ask);
  assertEquals(registry.resources.skills.planning.name, "planning");
});
