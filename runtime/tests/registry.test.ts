/**
 * Merging plugins: resources are configuration a later plugin patches (objects
 * merge, null removes, the rest replaces); Views and adapters are replaced by
 * name; collections, Actions and Processors stay unique (a later plugin may
 * add indexes to a collection).
 */
import { assertEquals, assertThrows } from "@std/assert";
import { definePlugin } from "../mod.ts";
import { merge, patch } from "../registry.ts";
import { test } from "../../testing/mod.ts";

test("patch: objects merge, null removes, everything else replaces", () => {
  const run = () => "new";
  assertEquals(
    patch(
      { a: 1, b: { c: 2, d: [1, 2], e: "x" }, f: { g: 1 } },
      { a: 2, b: { d: [3], e: null, h: { i: null, j: 1 } }, f: "flat", k: run },
    ),
    { a: 2, b: { c: 2, d: [3], h: { j: 1 } }, f: "flat", k: run },
  );
  // A patch's nulls never land, even where nothing was before.
  assertEquals(patch(undefined, { a: null, b: { c: null } }), { b: {} });
  // Not plain objects: replaced whole.
  const date = new Date(0);
  assertEquals(patch({ when: { day: 1 } }, { when: date }), { when: date });
});

test("a later plugin changes what it names in a resource and removes with null", () => {
  const lib = definePlugin({
    name: "lib",
    resources: {
      agents: {
        lead: { instructions: "Lead.", model: "openai/gpt-6.1-sol", effort: "low", tools: ["a"] },
        helper: { instructions: "Help." },
      },
    },
    adapters: { llm: { one: { generate: "lib" }, two: { generate: "lib" } } },
    views: { message: { llm: () => "lib", react: () => "lib" } },
  });
  const app = definePlugin({
    name: "app",
    resources: {
      agents: {
        lead: { effort: "high", tools: ["b"] },
        helper: null,
        extra: { instructions: "X" },
      },
      cost: { "openai/gpt-6.1-sol": { input: 1.8 } },
    },
    adapters: { llm: { one: { generate: "app" }, two: null } },
    views: { message: { react: null } },
  });
  const registry = merge([lib, app]);
  assertEquals(registry.resources.agents, {
    lead: { instructions: "Lead.", model: "openai/gpt-6.1-sol", effort: "high", tools: ["b"] },
    extra: { instructions: "X" },
  });
  assertEquals(registry.resources.cost, { "openai/gpt-6.1-sol": { input: 1.8 } });
  assertEquals(registry.adapters.llm, { one: { generate: "app" } });
  assertEquals(Object.keys(registry.views.message), ["llm"]);
  // The plugins' own declarations are left as they were.
  assertEquals((lib.resources!.agents.lead as { effort: string }).effort, "low");
});

test("collections, Actions and Processors stay unique", () => {
  const twice = (plugin: Parameters<typeof definePlugin>[0]) => () =>
    merge([plugin, { ...plugin, name: "again" }]);
  assertThrows(twice({ name: "a", collections: { note: { schema: {} } } }), Error, "collection");
  assertThrows(twice({ name: "a", actions: { "a.do": { run: () => 1 } } }), Error, "action");
  assertThrows(
    twice({ name: "a", processors: { p: { on: "*", run: () => 1 } } }),
    Error,
    "processor",
  );
});

test("a later plugin adds indexes to a collection another declared, and only that", () => {
  const lib = definePlugin({
    name: "lib",
    collections: { usage: { schema: { type: "object" }, indexes: [["at"]] } },
  });
  const app = definePlugin({
    name: "app",
    collections: { usage: { indexes: [["tags.tenant", "at"]] } },
  });
  assertEquals(merge([lib, app]).collections.usage.indexes, [["at"], ["tags.tenant", "at"]]);
  // The plugin's own definition is shared by every runtime: it stays as declared.
  assertEquals(lib.collections!.usage.indexes, [["at"]]);
  assertThrows(() => merge([app, lib]), Error, "no earlier plugin declares");
});

test("a plugin's runtime has what it builds on", () => {
  const base = definePlugin({ name: "base" });
  const ext = definePlugin({ name: "ext", requires: ["base"] });
  assertEquals(merge([base, ext]).checks, []);
  assertThrows(() => merge([ext]), Error, "ext needs base");
});
