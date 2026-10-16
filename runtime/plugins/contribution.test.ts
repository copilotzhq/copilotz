import {
  deepStrictEqual as assertEquals,
  strictEqual as assertStrictEquals,
  throws,
} from "node:assert/strict";
import { test } from "node:test";

import { defineView } from "../views/index.ts";
import { defineAction } from "../actions/define.ts";
import {
  type CompositionContribution,
  contribution,
  type ContributionResult,
  createPluginRegistry,
  definePlugin,
} from "./index.ts";

function assertThrows(
  fn: () => unknown,
  constructor: new (message?: string) => Error,
  message?: string,
): void {
  throws(fn, (error: unknown) =>
    error instanceof constructor &&
    (message === undefined || error.message.includes(message)));
}

const execute = defineAction({ id: "example.execute", execute: () => "ok" });
const declaration = {
  [contribution]({ alias }: { alias: string }) {
    return { value: { action: alias }, actions: { [alias]: execute } };
  },
};

test("generic contributions expand once without mutating reusable declarations", () => {
  const resources = { example: { run: declaration } };
  const plugin = definePlugin({ id: "example", version: "1", resources });
  assertStrictEquals(plugin.actions.run, execute);
  assertEquals(plugin.resources.example.run, { action: "run" });
  assertStrictEquals(resources.example.run, declaration);
  const registry = createPluginRegistry({ resources });
  assertStrictEquals(registry.actions.run, execute);
  assertEquals(registry.resources.example.run, { action: "run" });
});

test("root resources override dependencies without changing another app", () => {
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

test("contributed dependencies compose once and propagate their inferred namespace types", () => {
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

test("contribution collisions and asynchronous expansion fail before execution", () => {
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

test("contributions reject unsafe namespaces and nested declarations", () => {
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

test("root contributions preserve explicitly declared plugin Actions and resources", () => {
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

test("Skills at the root preserve Core and application type inference", async () => {
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

test("contributed Views retain exact aliases, item and output types at plugin and root boundaries", () => {
  const board = defineView({
    id: "board.context",
    shows: "board",
    renderer: "text",
    modes: ["context"],
    render: (item: { title: string }) => item.title,
  });
  const summary = defineView({
    id: "board.summary",
    shows: { list: "board" },
    renderer: "text",
    modes: ["context"],
    render: (items: readonly { title: string }[]) => items.length,
  });
  let expanded = 0;
  const resource = {
    [contribution]() {
      expanded += 1;
      return { value: { kind: "board" as const }, views: { board } };
    },
  };
  const adapter = {
    [contribution]() {
      return { value: { format: "summary" as const }, views: { summary } };
    },
  };
  const resources = { display: { main: resource } };
  const adapters = { display: { summary: adapter } };
  const plugin = definePlugin({
    id: "display",
    version: "1",
    resources,
    adapters,
  });
  const pluginView: typeof board = plugin.views.board;
  const registry = createPluginRegistry({ plugins: [plugin] });
  const root = createPluginRegistry({ resources, adapters });
  const rootBoard: typeof board = root.views.board;
  const rootSummary: typeof summary = root.views.summary;
  const noPhantomActions: keyof typeof root.actions extends never ? true
    : false = true;
  const exactViewAliases: string extends keyof typeof root.views ? false
    : true = true;
  assertEquals([noPhantomActions, exactViewAliases], [true, true]);
  const kind: "board" = root.resources.display.main.kind;
  const format: "summary" = root.adapters.display.summary.format;
  assertEquals([kind, format], ["board", "summary"]);
  assertEquals(expanded, 2);
  assertStrictEquals(pluginView, board);
  assertStrictEquals(registry.views.board, board);
  assertStrictEquals(rootBoard, board);
  assertStrictEquals(rootSummary, summary);
  assertStrictEquals(root.resolveView("board", "context", "text"), board);
  assertStrictEquals(resources.display.main, resource);
  assertStrictEquals(adapters.display.summary, adapter);
});

test("contribution dependencies include Views without losing other primitive inference", () => {
  const board = defineView({
    id: "board.context",
    shows: "board",
    renderer: "text",
    modes: ["context"],
    render: (item: string) => item,
  });
  const dependency = definePlugin({
    id: "display-base",
    version: "1",
    views: { board },
    actions: { run: execute },
  });
  const declaration = {
    [contribution]() {
      return { value: "ready" as const, plugins: [dependency] as const };
    },
  };
  const registry = createPluginRegistry({
    resources: { display: { main: declaration } },
  });
  const typed: typeof board = registry.views.board;
  const ready: "ready" = registry.resources.display.main;
  assertStrictEquals(typed, board);
  assertStrictEquals(registry.actions.run, execute);
  assertEquals(ready, "ready");
});

test("contributed View collisions and malformed maps fail before rendering", () => {
  const board = defineView({
    id: "board.context",
    shows: "board",
    renderer: "text",
    modes: ["context"],
    render: () => "board",
  });
  const resource = {
    [contribution]() {
      return { value: true, views: { board } };
    },
  };
  assertThrows(
    () =>
      definePlugin({
        id: "collision",
        version: "1",
        views: { board },
        resources: { display: { main: resource } },
      }),
    TypeError,
    "views.board",
  );
  for (const views of [[], null, { invalid: {} }]) {
    assertThrows(
      () =>
        definePlugin({
          id: "invalid",
          version: "1",
          resources: {
            display: {
              main: {
                [contribution]() {
                  return { value: true, views };
                },
              },
            },
          },
        }),
      TypeError,
      "views",
    );
  }
});

test("legacy annotated contributions do not claim nonexistent Views", () => {
  type EmptyMap = Readonly<Record<never, never>>;
  const result: ContributionResult<string, EmptyMap> = { value: "legacy" };
  const resource: CompositionContribution<string, EmptyMap, readonly []> = {
    [contribution]() {
      return result;
    },
  };
  const registry = createPluginRegistry({
    resources: { legacy: { example: resource } },
  });
  assertEquals(registry.resources.legacy.example, "legacy");
  assertEquals(registry.views, {});
  // @ts-expect-error Legacy three-argument declarations do not contribute Views.
  assertEquals(registry.views.example, undefined);
});

test("actual Skill and Tool declarations retain their no-View composition types", async () => {
  const { defineSkill } = await import("../../plugins/skills/index.ts");
  const { defineTool } = await import(
    "../../plugins/core/authoring/define-tool/index.ts"
  );
  const registry = createPluginRegistry({
    resources: {
      skills: {
        planning: defineSkill({ root: "https://skills.test/planning/" }),
      },
      tools: {
        echo: defineTool({
          id: "legacy.echo",
          name: "Echo",
          description: "Return text",
          execute: (input: string) => input,
        }),
      },
    },
  });
  assertEquals(registry.resources.skills.planning.name, "planning");
  assertEquals(registry.resources.tools.echo.action, "echo");
  assertEquals(registry.actions.echo.id, "legacy.echo");
  assertEquals(registry.views, {});
  // @ts-expect-error A Skill resource does not create a matching View alias.
  assertEquals(registry.views.planning, undefined);
  // @ts-expect-error A Tool resource does not create a matching View alias.
  assertEquals(registry.views.echo, undefined);
});

test("explicitly annotated View contributions retain their exact View map", () => {
  type EmptyMap = Readonly<Record<never, never>>;
  const board = defineView({
    id: "annotated.board",
    shows: "board",
    renderer: "text",
    modes: ["context"],
    render: (item: string) => item,
  });
  const resource: CompositionContribution<
    string,
    EmptyMap,
    readonly [],
    { board: typeof board }
  > = {
    [contribution]() {
      return { value: "board", views: { board } };
    },
  };
  const registry = createPluginRegistry({
    resources: { display: { main: resource } },
  });
  const typed: typeof board = registry.views.board;
  assertStrictEquals(typed, board);
  // @ts-expect-error Explicit contributions use their declared View aliases.
  assertEquals(registry.views.main, undefined);
});
